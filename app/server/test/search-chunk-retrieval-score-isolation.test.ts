/**
 * #30 / #10 keyword score isolation -- overnight R21 (docs/overnight/DECISIONS.md,
 * search-polish slice).
 *
 * `search-chunk-v1.md`'s "Still NOT claimed" section measured a live leak: one
 * workspace's raw BM25 `score` for an UNCHANGED hit set fell from 5.65 to 2.38
 * after a second workspace indexed 12 nodes holding the same term. That
 * happens because `search_chunks_v1` has ONE FTS index shared by every
 * workspace: the answer SET is workspace-scoped, but the score VALUE depends
 * on every workspace's text, so a caller can read another workspace's term
 * statistics off a number it was never granted access to.
 *
 * R21's fix: `searchKnowledgeKeyword` returns an integer `rank` (1..n, stable
 * order -- score then node id, as before) and never a raw score. This is the
 * failing-first proof of that ruling: change ONLY workspace BETA's corpus,
 * and workspace ALPHA's response for the IDENTICAL query must be byte-for-byte
 * unchanged. Before the fix this is red (the raw score moves); after the fix
 * it is green (a single hit's rank is always 1, regardless of what any other
 * workspace holds).
 *
 * Semantic search is untouched here: `distance` is L2 between the query
 * vector and one stored row's own vector, never a corpus-wide statistic, so
 * it carries no equivalent leak (verified in the search-chunk-v1.md
 * amendment this slice adds).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { CHUNKER_VERSION } from "../src/publication/search-chunk";

const CHILD = join(import.meta.dir, "fixtures", "search-chunk-v1", "core", "gated-score-isolation.ts");
const TIMEOUT_MS = 120_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const PROFILE = "all-minilm";
const DIMS = 384;
// A shifted-frequency test term: distinctive enough that only the seeded
// rows below hold it, long enough that `ngram(3,3)` has real trigrams to
// score, ASCII so the fixture stays simple -- the leak is about the shared
// index's document-frequency statistics, not about script.
const TERM = "isotermprobe";
// Matches the overnight verifier's own measurement (12 nodes moved the
// score): enough documents to genuinely shift BM25's IDF for TERM.
const BETA_NODE_COUNT = 12;

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/search-chunk-v1/core/gated-score-isolation.ts");
test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});
const runIt = MISSING.length > 0 ? test.skip : test;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const N_ALPHA = pad("scoreIsoAlpha");
const R_ALPHA = pad("scoreIsoRevA");
// Fixed-width index: `pad` fills with "0", so a bare `${i}` would make
// beta-1's id equal beta-10's (the extra digit is itself a "0", absorbed by
// the same zero-fill) once i reaches double digits.
const nBeta = (i: number) => pad(`scoreIsoBeta${i.toString().padStart(2, "0")}`);
const rBeta = (i: number) => pad(`scoreIsoRevB${i.toString().padStart(2, "0")}`);

type Op = { label: string; facade: "publication" | "context" | "reader"; method: string; request?: unknown };

function buildOps(fixture: Fixture): { ops: Op[]; revisionIds: string[] } {
  const alpha = fixture.workspaces[ALPHA]!;
  const beta = fixture.workspaces[BETA]!;
  const ops: Op[] = [];
  const revisionIds: string[] = [];

  const publish = (label: string, workspace: string, seeded: typeof alpha, node: string, revision: string, body: string) => {
    revisionIds.push(revision);
    ops.push({
      label,
      facade: "publication",
      method: "publishRevision",
      request: { operation_id: `op-${label}`, content: revisionEnvelope(workspace, seeded, node, { title: "t", body }) },
    });
  };
  const index = (label: string, workspace: string, node: string, revision: string) =>
    ops.push({
      label,
      facade: "context",
      method: "indexRevisionChunks",
      request: { workspace_name: workspace, node_id: node, revision_id: revision, chunker_version: CHUNKER_VERSION, embedding_profile: { name: PROFILE, dims: DIMS } },
    });
  const keyword = (label: string) => ops.push({ label, facade: "reader", method: "searchKnowledgeKeyword", request: { workspace_name: ALPHA, query: TERM } });

  publish("pub_alpha", ALPHA, alpha, N_ALPHA, R_ALPHA, `alpha holds ${TERM} exactly once`);
  index("idx_alpha", ALPHA, N_ALPHA, R_ALPHA);
  keyword("kw_before");

  for (let i = 0; i < BETA_NODE_COUNT; i++) {
    publish(`pub_beta_${i}`, BETA, beta, nBeta(i), rBeta(i), `${TERM} ${TERM} ${TERM} beta document ${i} about ${TERM}`);
    index(`idx_beta_${i}`, BETA, nBeta(i), rBeta(i));
  }
  keyword("kw_after");

  return { ops, revisionIds };
}

let out: Record<string, any> = {};
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

const ok = (label: string) => {
  const result = out[label];
  expect(result, `${label}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
  return result.value;
};

describe("#30 / #10 keyword score isolation (R21)", () => {
  runIt(
    "workspace ALPHA's keyword response is byte-identical before and after workspace BETA's corpus changes",
    async () => {
      const fixture = await createFixture([ALPHA, BETA]);
      cleanups.push(fixture.cleanup);
      const { ops, revisionIds } = buildOps(fixture);
      const result = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot, JSON.stringify({ ops, revisionIds })], {
        deadlineMs: TIMEOUT_MS - 10_000,
      });
      if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
      out = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);

      ok("pub_alpha");
      ok("idx_alpha");
      for (let i = 0; i < BETA_NODE_COUNT; i++) {
        ok(`pub_beta_${i}`);
        ok(`idx_beta_${i}`);
      }

      const before = ok("kw_before");
      const after = ok("kw_after");

      // Sanity: both runs actually found ALPHA's one node, and nothing from
      // BETA ever entered ALPHA's answer set.
      expect(before.hits).toHaveLength(1);
      expect(before.hits[0].node_id).toBe(N_ALPHA);
      expect(JSON.stringify(before)).not.toContain(nBeta(0));

      // R21: no raw score on the wire, an integer rank instead.
      expect(before.hits[0]).not.toHaveProperty("score");
      expect(before.hits[0].rank).toBe(1);

      // The actual isolation proof: BETA's corpus grew by 12 nodes repeating
      // the same term between the two searches; ALPHA's byte-for-byte answer
      // must not have moved.
      expect(after).toEqual(before);
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    },
    TIMEOUT_MS,
  );
});
