/**
 * #30 overnight R7: `reconcileSearchChunks` correctness and `getSearchFreshness`.
 *
 * Failing-first evidence (analysis-30, `.tmp/understand/analysis-30.json`
 * ops op3/op6/op8/op12 on the pre-fix code): reconcile's old `limit 1`
 * presence probe read a partial chunk set as complete, ignored the embedding
 * profile entirely, and its `continue` on a missing head skipped the stale
 * probe for that same node. `getSearchFreshness` did not exist at all.
 *
 * Scope, per the ruling: presence is recomputed against the head's own
 * title/body (never trusted from row COUNT alone), scoped to
 * (revision_id, CHUNKER_VERSION, active profile); ineligible (retired or
 * superseded) nodes are excluded from missing/incomplete/hash_mismatch/stale
 * accounting; missing_source and pending/ready/failed are global, bounded by
 * the node sweep. Reuses `search-chunk-precision.test.ts`'s
 * `precision/seed-child.ts` child (`insertRawChunk`/`deleteChunkById`) rather
 * than inventing a third raw-row planter.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type SeededWorkspace } from "./helpers/publication-fixture";
import {
  CHUNKER_VERSION,
  activeEmbeddingProfileId,
  deriveChunkId,
  deriveContentHash,
} from "../src/publication/search-chunk";

const CHILD = new URL("./fixtures/search-chunk-v1/precision/seed-child.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");
const TEST_TIMEOUT_MS = 300_000;
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

describe("reconcileSearchChunks: incomplete is distinct from missing", () => {
  test("deleting one chunk of three reports incomplete=1, not missing", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("rc-nodeA");
      const revA = pad("rc-revA");
      const body = "x".repeat(2500); // 3 chunks: title+\n\n+body crosses 2000 chars twice.
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-rc-a1", { body }),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          hx("deleteChunkById", { id: deriveChunkId(revA, CHUNKER_VERSION, PROFILE_ID, 1n) }),
          reconcile(),
        ],
        { revisionIds: [revA] },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.value.rows).toHaveLength(3);
      const reconciled = parsed.op3.value;
      expect(reconciled.missing).toBe(0);
      expect(reconciled.incomplete).toBe(1);
      expect(reconciled.hash_mismatch).toBe(0);
      expect(reconciled.missing_revisions).toEqual([{ node_id: nodeA, revision_id: revA }]);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("reconcileSearchChunks: hash_mismatch is distinct from incomplete", () => {
  test("a present row whose content_hash no longer matches the recomputed one is hash_mismatch, not incomplete", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("rc-nodeB");
      const revA = pad("rc-revB");
      const chunkId = deriveChunkId(revA, CHUNKER_VERSION, PROFILE_ID, 0n);
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-rc-b1"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          hx("deleteChunkById", { id: chunkId }),
          hx("insertRawChunk", {
            rows: [
              rawChunkRow({
                id: chunkId,
                node_id: nodeA,
                revision_id: revA,
                type_term_id: seeded.term_ids.type.note.id,
                content_hash: "0".repeat(64), // WRONG: not deriveContentHash("a title\n\na body").
              }),
            ],
          }),
          reconcile(),
        ],
        { revisionIds: [revA] },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.value.rows).toHaveLength(1);
      // Premise: the corrupted hash really does disagree with the recomputed one.
      expect(deriveContentHash("a title\n\na body")).not.toBe("0".repeat(64));
      const reconciled = parsed.op4.value;
      expect(reconciled.missing).toBe(0);
      expect(reconciled.incomplete).toBe(0);
      expect(reconciled.hash_mismatch).toBe(1);
      expect(reconciled.missing_revisions).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("reconcileSearchChunks: ineligible nodes are excluded, not reported as gaps", () => {
  test("a retired, never-indexed node counts as ineligible, not missing", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("rc-nodeC");
      const revA = pad("rc-revC");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-rc-c1"),
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: nodeA,
            expected_revision_id: revA,
            reason: "no longer needed",
            peer_name: null,
            operation_id: "op-rc-c1-retire",
          }),
          reconcile(),
        ],
        { revisionIds: [revA] },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.value.outcome).toBe("accepted");
      const reconciled = parsed.op2.value;
      expect(reconciled.ineligible).toBe(1);
      expect(reconciled.missing).toBe(0);
      expect(reconciled.incomplete).toBe(0);
      expect(reconciled.missing_revisions).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("reconcileSearchChunks: missing_source is a global, sweep-bounded count", () => {
  test("a chunk row belonging to no visited node counts as missing_source", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("rc-nodeD");
      const revA = pad("rc-revD");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-rc-d1"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          hx("insertRawChunk", {
            rows: [rawChunkRow({ id: "f".repeat(64), node_id: pad("rc-ghost"), revision_id: pad("rc-ghostrev") })],
          }),
          reconcile(),
        ],
        { revisionIds: [revA] },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.value.rows).toHaveLength(1);
      const reconciled = parsed.op3.value;
      // The real, visited node's own chunk is fully satisfied.
      expect(reconciled.missing).toBe(0);
      expect(reconciled.incomplete).toBe(0);
      // The ghost row belongs to no visited node.
      expect(reconciled.missing_source).toBeGreaterThanOrEqual(1);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("reconcileSearchChunks: pending/ready/failed status counts", () => {
  test("three single-chunk nodes in three different statuses are counted correctly", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("rc-nodeE1");
      const nodeB = pad("rc-nodeE2");
      const nodeC = pad("rc-nodeE3");
      const revA = pad("rc-revE1");
      const revB = pad("rc-revE2");
      const revC = pad("rc-revE3");
      const idB = deriveChunkId(revB, CHUNKER_VERSION, PROFILE_ID, 0n);
      const idC = deriveChunkId(revC, CHUNKER_VERSION, PROFILE_ID, 0n);
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-rc-e1"),
          publish(seeded, nodeB, "op-rc-e2"),
          publish(seeded, nodeC, "op-rc-e3"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          ctx("indexRevisionChunks", indexRequest(nodeB, revB)),
          ctx("indexRevisionChunks", indexRequest(nodeC, revC)),
          // Flip B's row to ready and C's to failed, preserving id/content_hash
          // so they stay "present" for the completeness check -- only status
          // differs, which is exactly what this count is about.
          hx("deleteChunkById", { id: idB }),
          hx("insertRawChunk", {
            rows: [
              rawChunkRow({
                id: idB,
                node_id: nodeB,
                revision_id: revB,
                type_term_id: seeded.term_ids.type.note.id,
                content_hash: deriveContentHash("a title\n\na body"),
                status: "ready",
              }),
            ],
          }),
          hx("deleteChunkById", { id: idC }),
          hx("insertRawChunk", {
            rows: [
              rawChunkRow({
                id: idC,
                node_id: nodeC,
                revision_id: revC,
                type_term_id: seeded.term_ids.type.note.id,
                content_hash: deriveContentHash("a title\n\na body"),
                status: "failed",
                attempts: "1",
              }),
            ],
          }),
          reconcile(),
        ],
        { revisionIds: [revA, revB, revC] },
      );
      for (const key of ["op0", "op1", "op2", "op3", "op4", "op5"]) {
        expect(parsed[key].ok, `${key}: ${JSON.stringify(parsed[key])}`).toBe(true);
      }
      const reconciled = parsed.op10.value;
      expect(reconciled.missing).toBe(0);
      expect(reconciled.incomplete).toBe(0);
      expect(reconciled.hash_mismatch).toBe(0);
      expect(reconciled.pending).toBe(1);
      expect(reconciled.ready).toBe(1);
      expect(reconciled.failed).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("getSearchFreshness: per-stage freshness, unknown kept distinct from zero", () => {
  test("content counts are real, text_index is unknown (null) with no index built, vectors reflect status", async () => {
    // Integration merge: `indexRevisionChunks` now builds the text index
    // itself (search-chunk-v1.md section 13), so the index is first REAL
    // numbers here, and only a dataset with no index -- reached by dropping
    // it, the state of chunks indexed before that amendment -- is unknown.
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("rc-nodeF1");
      const nodeB = pad("rc-nodeF2");
      const revA = pad("rc-revF1");
      const revB = pad("rc-revF2");
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-rc-f1"),
          publish(seeded, nodeB, "op-rc-f2"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          freshness(),
          hx("dropTextIndex", {}),
          freshness(),
        ],
        { revisionIds: [revA, revB] },
      );
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.value.outcome).toBe("accepted");
      // The writer built the index over alpha's one chunk row: real numbers.
      expect(parsed.op3.value.text_index).toEqual({ indexed_rows: 1, unindexed_rows: 0 });
      expect(parsed.op4.value).toEqual({ remaining: 0 });
      const fresh = parsed.op5.value;
      expect(fresh.content).toEqual({ nodes: 2, revisions: 2 });
      // No text index left on the table: unknown, reported as null, never as
      // a false zero.
      expect(fresh.text_index.indexed_rows).toBeNull();
      expect(fresh.text_index.unindexed_rows).toBeNull();
      expect(fresh.vectors).toEqual({
        profile_id: PROFILE_ID,
        pending: 1,
        ready: 0,
        failed: 0,
        last_attempt_at: null,
        // R20: nothing embedded, nothing measured in this process yet.
        model_digest: { pinned: null, last_measured: null },
      });
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("last_attempt_at reflects the latest attempt once one has happened", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const seeded = fixture.workspaces[ALPHA]!;
      const nodeA = pad("rc-nodeF3");
      const revA = pad("rc-revF3");
      const chunkId = deriveChunkId(revA, CHUNKER_VERSION, PROFILE_ID, 0n);
      const attemptMicros = String(BigInt(CLOCK) * 1000n); // an exact, ms-aligned microsecond instant.
      const parsed = await drive(
        fixture.datasetRoot,
        [
          publish(seeded, nodeA, "op-rc-f3"),
          ctx("indexRevisionChunks", indexRequest(nodeA, revA)),
          hx("deleteChunkById", { id: chunkId }),
          hx("insertRawChunk", {
            rows: [
              rawChunkRow({
                id: chunkId,
                node_id: nodeA,
                revision_id: revA,
                type_term_id: seeded.term_ids.type.note.id,
                content_hash: deriveContentHash("a title\n\na body"),
                status: "failed",
                attempts: "1",
                last_attempt_at_micros: attemptMicros,
              }),
            ],
          }),
          freshness(),
        ],
        { revisionIds: [revA] },
      );
      const fresh = parsed.op4.value;
      expect(fresh.vectors.failed).toBe(1);
      expect(fresh.vectors.last_attempt_at).toBe("2026-09-21T00:00:00.000Z");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
