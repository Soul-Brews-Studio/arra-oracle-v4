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
 * order -- score then node id, as before) and never a raw score. The first
 * `describe` below is the failing-first proof of exactly that: change ONLY
 * workspace BETA's corpus, and a SINGLE-hit answer's raw `score` moved before
 * the fix; its `rank` is always `1` after, regardless of what any other
 * workspace holds.
 *
 * That single-hit proof is deliberately narrow, and an independent verifier
 * (2026-09-27) showed why it cannot be read as "isolation, full stop": `rank`
 * is a POSITION, and the position of a multi-hit answer still comes from BM25
 * order, which is computed from the shared index's corpus-wide IDF and
 * average document length. Changing only BETA's corpus can still swap which
 * of ALPHA's OWN nodes ranks first -- and therefore, at a bounded `limit`,
 * which of ALPHA's own nodes is even returned. `rank` closes the raw-score
 * VALUE leak; it does not make hit ORDER (or limit-bound membership)
 * workspace-local. The second `describe` below is the failing-first proof of
 * THAT residual leak (mirrors the verifier's own repro), and it stays green
 * on purpose: it pins the honest, currently-true claim -- the SET of node ids
 * never crosses a workspace boundary and the raw score is never on the wire,
 * but the ORDER between two of ALPHA's own hits is not guaranteed stable
 * against BETA's writes. Closing that fully needs a per-workspace index or
 * per-workspace statistics (R21's own "reverse by" line) -- out of scope for
 * this slice, and recorded, not hidden, in `search-chunk-v1.md`'s amendment.
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
import { CHUNKER_VERSION, activeEmbeddingProfileId } from "../src/publication/search-chunk";

const CHILD = join(import.meta.dir, "fixtures", "search-chunk-v1", "core", "gated-score-isolation.ts");
const TIMEOUT_MS = 120_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
// #30 R7 (search-embed, R20): the closed profile registry accepts only its
// active id; the bare model name this slice was written against is refused.
const PROFILE = activeEmbeddingProfileId();
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

describe("#30 / #10 keyword score isolation (R21) -- single hit, raw score removed", () => {
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

// ── Residual leak: rank order (and, at a bounded limit, membership) is NOT
// workspace-local -- the verifier's own repro, kept honest ──────────────────
//
// Two ALPHA nodes both contain the query once, so a caller sees BOTH; which
// one this answer's `rank: 1` names is decided by BM25, and BM25's IDF is a
// property of the shared index, not of ALPHA's corpus alone. A1 additionally
// repeats the query's own "abc" trigram, A2 repeats its "def" trigram; BETA
// then indexes nodes that repeat ONLY "abc" (never the query itself, so BETA
// never becomes a candidate) -- exactly enough to depress "abc"'s corpus-wide
// IDF and make A2 outrank A1, with nothing ALPHA wrote changing in between.
const ORDER_TERM = "orderleakabcdef";
const ORDER_A1 = pad("orderLeakA1");
const ORDER_A1_REV = pad("orderLeakA1Rev");
const ORDER_A2 = pad("orderLeakA2");
const ORDER_A2_REV = pad("orderLeakA2Rev");
const ORDER_BETA_ABC_NODE_COUNT = 12; // matches the verifier's own measurement

function buildOrderLeakOps(fixture: Fixture): { ops: Op[]; revisionIds: string[] } {
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
  const keyword = (label: string) => ops.push({ label, facade: "reader", method: "searchKnowledgeKeyword", request: { workspace_name: ALPHA, query: ORDER_TERM, limit: 2 } });

  publish("pub_order_a1", ALPHA, alpha, ORDER_A1, ORDER_A1_REV, `${ORDER_TERM} ${"abc".repeat(40)}`);
  index("idx_order_a1", ALPHA, ORDER_A1, ORDER_A1_REV);
  publish("pub_order_a2", ALPHA, alpha, ORDER_A2, ORDER_A2_REV, `${ORDER_TERM} ${"def".repeat(40)}`);
  index("idx_order_a2", ALPHA, ORDER_A2, ORDER_A2_REV);
  keyword("kw_order_before");

  for (let i = 0; i < ORDER_BETA_ABC_NODE_COUNT; i++) {
    // Fixed-width index, as `nBeta`/`rBeta` above: `pad` fills with "0", so a
    // bare `${i}` would make beta-1's id equal beta-10's once i reaches
    // double digits.
    const node = pad(`orderLeakBeta${i.toString().padStart(2, "0")}`);
    const revision = pad(`orderLeakBetaRev${i.toString().padStart(2, "0")}`);
    publish(`pub_order_beta_${i}`, BETA, beta, node, revision, "abc".repeat(60));
    index(`idx_order_beta_${i}`, BETA, node, revision);
  }
  keyword("kw_order_after");

  return { ops, revisionIds };
}

describe("#30 / #10 keyword rank order (R21 fix-round) -- the leak rank alone does not close", () => {
  runIt(
    "changing ONLY workspace BETA's corpus can still swap which of ALPHA's own nodes ranks first",
    async () => {
      const fixture = await createFixture([ALPHA, BETA]);
      cleanups.push(fixture.cleanup);
      const { ops, revisionIds } = buildOrderLeakOps(fixture);
      const result = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot, JSON.stringify({ ops, revisionIds })], {
        deadlineMs: TIMEOUT_MS - 10_000,
      });
      if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
      out = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);

      ok("pub_order_a1");
      ok("idx_order_a1");
      ok("pub_order_a2");
      ok("idx_order_a2");
      for (let i = 0; i < ORDER_BETA_ABC_NODE_COUNT; i++) {
        ok(`pub_order_beta_${i}`);
        ok(`idx_order_beta_${i}`);
      }

      const before = ok("kw_order_before");
      const after = ok("kw_order_after");

      // The honest, currently-true guarantee: the SET never crosses a
      // workspace boundary, and neither answer ever carries a raw score.
      for (const answer of [before, after]) {
        expect(answer.hits.map((hit: { node_id: string }) => hit.node_id).sort()).toEqual([ORDER_A1, ORDER_A2].sort());
        for (const hit of answer.hits) expect(hit).not.toHaveProperty("score");
        expect(answer.hits.map((hit: { rank: number }) => hit.rank)).toEqual([1, 2]);
      }

      // The residual leak, reproduced rather than assumed away: ALPHA wrote
      // nothing between these two searches. Only BETA's "abc"-repeating
      // corpus grew, and that alone flips which of ALPHA's own nodes this
      // answer names first (and so, at `limit: 1`, which one comes back).
      expect(before.hits.map((hit: { node_id: string }) => hit.node_id)).toEqual([ORDER_A1, ORDER_A2]);
      expect(after.hits.map((hit: { node_id: string }) => hit.node_id)).toEqual([ORDER_A2, ORDER_A1]);
    },
    TIMEOUT_MS,
  );
});
