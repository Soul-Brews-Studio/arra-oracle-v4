/**
 * #30 overnight R7 fix round: three `reconcileSearchChunks`/`getSearchFreshness`
 * test-quality gaps the independent verifier found, split out of
 * `search-chunk-reconcile.test.ts` to keep that file under the 500-line cap
 * (Nat's style rule) rather than crossing it -- this file, not that one, is
 * new to the fix round.
 *
 * Each test below pins a property the PRODUCTION code already gets right at
 * HEAD; what was missing was a test that would actually catch a regression:
 *
 * - `stale` was never asserted `> 0` anywhere in the suite -- the verifier's
 *   mutation M2 (reinstating the pre-fix `continue` that skipped the stale
 *   probe whenever the head itself was unindexed) passed all 74
 *   search-chunk/workspace-isolation tests with no failure.
 * - Reconcile's presence query was never proven to be SCOPED to the active
 *   embedding profile -- the verifier's mutation M3 (dropping the
 *   `AND embedding_profile = ...` clause) passed all 55 search-chunk tests.
 * - `getSearchFreshness.text_index` was never proven workspace-isolated --
 *   `DatasetAdapter.textIndexStats` answers `indexStats()` for the ONE
 *   shared `search_chunks_v1` table (R7), with no per-predicate variant.
 *   Measured pre-fix: a workspace with zero chunks of its own reported
 *   ANOTHER workspace's `indexed_rows`/`unindexed_rows` verbatim, once a
 *   shared FTS index existed.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type SeededWorkspace } from "./helpers/publication-fixture";
import {
  CHUNKER_VERSION,
  activeEmbeddingProfileId,
  deriveChunkId,
  deriveContentHash,
} from "../src/publication/search-chunk";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/search-chunk-v1/precision/seed-child.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
const TEST_TIMEOUT_MS = testTimeout(300_000);
const PROFILE_ID = activeEmbeddingProfileId();

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

const drive = async (
  root: string,
  ops: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>> => {
  const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 1200)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 1200)}`);
  return JSON.parse(line);
};

const publish = (seeded: SeededWorkspace, node: string, operation: string, overrides: Record<string, unknown> = {}) =>
  pub("publishRevision", {
    operation_id: operation,
    content: revisionEnvelope(ALPHA, seeded, node, overrides),
  });

const indexRequest = (node: string, revision: string) => ({
  workspace_name: ALPHA,
  node_id: node,
  revision_id: revision,
  chunker_version: CHUNKER_VERSION,
  embedding_profile: { name: PROFILE_ID, dims: 384 },
});

const reconcile = (limit = 1024) => ctx("reconcileSearchChunks", { workspace_name: ALPHA, limit });
const freshness = () => ctx("getSearchFreshness", { workspace_name: ALPHA });

const rawChunkRow = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: "a".repeat(64),
  workspace_name: ALPHA,
  node_id: pad("ghost-node"),
  revision_id: pad("ghost-rev"),
  chunk_index: "0",
  text: "placeholder",
  content_hash: "b".repeat(64),
  chunker_version: CHUNKER_VERSION,
  embedding_profile: PROFILE_ID,
  type_term_id: pad("term1"),
  term_ids: [],
  status: "pending",
  attempts: "0",
  ...overrides,
});

describe("reconcileSearchChunks: stale runs even when the head itself is unindexed (fix round)", () => {
  /**
   * Fix-round test-quality finding: the *production* code already runs the
   * stale probe unconditionally (analysis-30 op8 is fixed at HEAD), but
   * nothing in this suite ever asserted `stale > 0` -- the independent
   * verifier's mutation M2 (reinstating the pre-fix `continue` that skipped
   * the stale probe whenever the head itself was unindexed) passed all 74
   * search-chunk/workspace-isolation tests with no failure. This test pins
   * the actual property: publish A1, index it, then publish A2 (a NEW
   * accepted head, base A1, deliberately never indexed) -- A1's chunk rows
   * now survive under a node whose accepted head is A2, so `stale` must be
   * 1 and, since A2 itself was never indexed, `missing` must also be 1.
   * Reverting to the pre-fix `continue` makes this go stale=0.
   */
  test("publish A1, index, publish A2 (unindexed): missing=1 AND stale=1, neither suppresses the other", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("rc-nodeG");
      const revA1 = pad("rc-revG1");
      const revA2 = pad("rc-revG2");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-rc-g1"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA1)),
          publish(seeded, nodeA, "op-rc-g2", { base_revision_id: revA1 }),
          reconcile(),
        ],
        { revisionIds: [revA1, revA2] },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.value.rows).toHaveLength(1);
      expect(parsed.op2.value.outcome).toBe("accepted");
      const reconciled = parsed.op3.value;
      // A2 is the new accepted head and was never indexed.
      expect(reconciled.missing).toBe(1);
      expect(reconciled.missing_revisions).toEqual([{ node_id: nodeA, revision_id: revA2 }]);
      // A1's chunk rows are still there, under a revision that is no longer
      // the head -- THIS is what stale means, and it must be reported
      // alongside missing, not instead of it.
      expect(reconciled.stale).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("reconcileSearchChunks: presence is scoped to the active embedding profile (fix round)", () => {
  /**
   * Fix-round test-quality finding: the independent verifier's mutation M3
   * (dropping the `AND embedding_profile = ...` clause from the presence
   * query) passed all 55 search-chunk tests -- nothing in this suite
   * planted a chunk row under a NON-active profile id and then asked
   * reconcile whether the ACTIVE profile still considered that revision
   * indexed. It must not: a row that exists only under a retired/foreign
   * profile id is exactly as absent, for the active profile's own
   * completeness question, as a revision indexed under no profile at all.
   */
  test("a revision indexed only under a non-active profile id counts as missing for the active one", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("rc-nodeH");
      const revA = pad("rc-revH");
      const foreignProfileId = "ollama/all-minilm@retired000000/384/none";
      expect(foreignProfileId).not.toBe(PROFILE_ID);
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-rc-h1"),
          hx("insertRawChunk", {
            rows: [
              rawChunkRow({
                id: deriveChunkId(revA, CHUNKER_VERSION, foreignProfileId, 0n),
                node_id: nodeA,
                revision_id: revA,
                type_term_id: seeded.term_ids.type.note.id,
                content_hash: deriveContentHash("a title\n\na body"),
                embedding_profile: foreignProfileId,
              }),
            ],
          }),
          reconcile(),
        ],
        { revisionIds: [revA] },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      const reconciled = parsed.op2.value;
      // Present under the foreign id only -- absent for the active one.
      expect(reconciled.missing).toBe(1);
      expect(reconciled.missing_revisions).toEqual([{ node_id: nodeA, revision_id: revA }]);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("getSearchFreshness: text_index never leaks another workspace's counts (fix round finding 5)", () => {
  /**
   * `DatasetAdapter.textIndexStats` answers `indexStats()` for the ONE
   * shared `search_chunks_v1` table (R7) -- LanceDB has no per-predicate
   * variant. Measured pre-fix: building the shared index over ALPHA's
   * chunks and then calling `getSearchFreshness` for BETA (0 nodes, 0
   * chunks of its own) reported ALPHA's `indexed_rows`/`unindexed_rows`
   * verbatim. The fix only ever attributes the table-wide figures to a
   * workspace that provably owns every row currently in the table; every
   * OTHER workspace gets `null` (unknown), never a foreign number.
   */
  test("beta (0 chunks) reports null text_index once alpha's chunks are indexed, never alpha's numbers", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const seededAlpha = fixture.workspaces[ALPHA]!;
      const nodeA = pad("rc-nodeI");
      const revA = pad("rc-revI");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seededAlpha, nodeA, "op-rc-i1"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          hx("buildTextIndex", {}),
          freshness(), // alpha
          ctx("getSearchFreshness", { workspace_name: BETA }),
        ],
        { revisionIds: [revA] },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.value.rows).toHaveLength(1);
      expect(parsed.op2.ok, JSON.stringify(parsed.op2)).toBe(true);

      // Alpha owns every chunk row in the table right now: safe to attribute
      // the table-wide index stats to alpha, and they must be real numbers.
      const alphaFresh = parsed.op3.value;
      expect(alphaFresh.text_index.indexed_rows).not.toBeNull();

      // Beta has zero chunks of its own -- it must NEVER see alpha's
      // numbers, and must NEVER see a false zero either (a workspace this
      // method cannot honestly measure reports unknown, not a guess).
      const betaFresh = parsed.op4.value;
      expect(betaFresh.content).toEqual({ nodes: 0, revisions: 0 });
      expect(betaFresh.text_index.indexed_rows).toBeNull();
      expect(betaFresh.text_index.unindexed_rows).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  /**
   * Fix round 2 (verifier nonblocking): the test above only covers a
   * workspace with ZERO chunks, so the mutation `scopedChunks > 0 ||
   * scopedChunks === allChunks` -- which hands the table-wide figures to any
   * workspace owning at least one chunk, the realistic multi-tenant leak --
   * still passed it. Here both workspaces own chunks; neither owns all of
   * them, so neither may see the shared table's numbers.
   */
  test("alpha and beta each own chunks: neither sees the table-wide text_index figures", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const nodeA = pad("rc-nodeJa");
      const nodeB = pad("rc-nodeJb");
      const revA = pad("rc-revJa");
      const revB = pad("rc-revJb");
      const indexIn = (workspace: string, node: string, revision: string) =>
        ctx("indexRevisionChunks", { ...indexRequest(node, revision), workspace_name: workspace });
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(fixture.workspaces[ALPHA]!, nodeA, "op-rc-ja"),
          indexIn(ALPHA, nodeA, revA),
          pub("publishRevision", {
            operation_id: "op-rc-jb",
            content: revisionEnvelope(BETA, fixture.workspaces[BETA]!, nodeB),
          }),
          indexIn(BETA, nodeB, revB),
          hx("buildTextIndex", {}),
          freshness(),
          ctx("getSearchFreshness", { workspace_name: BETA }),
        ],
        { revisionIds: [revA, revB] },
      );
      expect(parsed.op1.value.rows, JSON.stringify(parsed.op1)).toHaveLength(1);
      expect(parsed.op3.value.rows, JSON.stringify(parsed.op3)).toHaveLength(1);
      expect(parsed.op4.ok, JSON.stringify(parsed.op4)).toBe(true);
      for (const fresh of [parsed.op5.value, parsed.op6.value]) {
        expect(fresh.text_index).toEqual({ indexed_rows: null, unindexed_rows: null });
      }
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
