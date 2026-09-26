/**
 * #30 / #10 keyword retrieval: the MEASURED bound of R22's isolation
 * (docs/overnight/DECISIONS.md R22, "Known residual").
 *
 * R22 lets BM25 over the shared FTS index SELECT candidate chunks and nothing
 * more; the order is ALPHA's own. The candidates are read by the one
 * overfetch loop (`fts/fts.overfetch.ts`): the first round asks the index for
 * `limit * FTS_CANDIDATE_FACTOR` chunks (4 per requested hit), in BM25 order,
 * and the loop stops as soon as `limit` nodes survive. So:
 *
 * - AT OR BELOW THE BOUND -- ALPHA has at most `limit * FTS_CANDIDATE_FACTOR`
 *   candidate chunks for the query (every ALPHA chunk sharing a trigram with
 *   it) -- the first round reads ALL of them, BM25 order decides nothing, and
 *   the answer is a function of ALPHA's rows alone. BETA-only writes cannot
 *   move it.
 * - ABOVE IT, the round reads only BM25's top `limit * FTS_CANDIDATE_FACTOR`,
 *   and BM25 is corpus-wide: which of ALPHA's chunks make that cut can change
 *   when only BETA writes. The answer is still ordered by R22 and still holds
 *   only ALPHA's nodes, but it is R22's best among BM25's picks, not among
 *   all of ALPHA's matches. This is the residual R22 names; a per-workspace
 *   index closes it. It is measured here, not assumed.
 *
 * The corpus (every ALPHA node holds the query exactly once, one fixed writer
 * clock, so R22 orders by node id and X -- the smallest id -- is R22's first):
 *
 *   X          query + "def" x 40 + a few non-query trigrams (a little
 *              LONGER than the F nodes, so BM25 ranks it strictly LAST until
 *              BETA writes)
 *   F1..Fk     query + "abc" x 40
 *   BETA       12 nodes of "abc" x 60 -- never a candidate for ALPHA (they do
 *              not hold the query), but they crush "abc"'s corpus-wide IDF,
 *              which lifts X strictly FIRST in BM25.
 *
 * At the bound (k = factor*limit - 1, so X + F = the first round) the
 * `limit: 1` answer is X before and after. Past it (k = 2*factor*limit - 1, X
 * + F = twice the first round) X is outside the first round until BETA
 * writes: the answer moves from F1 to X.
 *
 * Both ALPHA sizes are powers of two on purpose. The writer's index step
 * (`fts.refreshStaleFtsIndexOn`) rebuilds once the unindexed rows reach the
 * indexed ones, so after 2^n single-chunk index calls EVERY row is indexed.
 * A row still unindexed is scanned outside the index and scored apart from
 * it (measured on 0.38.0: with X + 4 F, the fifth, unindexed F came back
 * BM25-last, below X). Keeping every ALPHA row indexed leaves BETA's
 * statistics as the only thing that moves.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { FTS_CANDIDATE_FACTOR } from "../src/fts/fts";
import { CHUNKER_VERSION, activeEmbeddingProfileId } from "../src/publication/search-chunk";

const CHILD = join(import.meta.dir, "fixtures", "search-chunk-v1", "core", "gated-score-isolation.ts");
const TIMEOUT_MS = 120_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const PROFILE = activeEmbeddingProfileId();
const QUERY = "orderleakabcdef";
const LIMIT = 1;
/** The first overfetch round: how many candidate chunks R22's isolation covers. */
const FIRST_ROUND = LIMIT * FTS_CANDIDATE_FACTOR;
const BETA_NODE_COUNT = 12;

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/search-chunk-v1/core/gated-score-isolation.ts");
test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});
const runIt = MISSING.length > 0 ? test.skip : test;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const X = pad("boundA");
const f = (i: number) => pad(`boundF${i.toString().padStart(2, "0")}`);

type Op = { label: string; facade: "publication" | "context" | "reader"; method: string; request?: unknown };
type Hit = { node_id: string; rank: number };

/** ALPHA: X plus `fCount` F nodes, searched; BETA writes; ALPHA searched again. */
function buildOps(fixture: Fixture, fCount: number): { ops: Op[]; revisionIds: string[] } {
  const ops: Op[] = [];
  const revisionIds: string[] = [];
  const publishAndIndex = (workspace: string, node: string, body: string) => {
    const revision = pad(`r${node.slice(0, 20)}`);
    revisionIds.push(revision);
    const seeded = fixture.workspaces[workspace]!;
    ops.push({
      label: `pub_${node}`,
      facade: "publication",
      method: "publishRevision",
      request: { operation_id: `op-${node}`, content: revisionEnvelope(workspace, seeded, node, { title: "t", body }) },
    });
    ops.push({
      label: `idx_${node}`,
      facade: "context",
      method: "indexRevisionChunks",
      request: { workspace_name: workspace, node_id: node, revision_id: revision, chunker_version: CHUNKER_VERSION, embedding_profile: { name: PROFILE, dims: 384 } },
    });
  };
  const search = (label: string, limit: number) =>
    ops.push({ label, facade: "reader", method: "searchKnowledgeKeyword", request: { workspace_name: ALPHA, query: QUERY, limit } });

  publishAndIndex(ALPHA, X, `${QUERY} ${"def".repeat(40)} ${"xyz".repeat(2)}`);
  for (let i = 1; i <= fCount; i++) publishAndIndex(ALPHA, f(i), `${QUERY} ${"abc".repeat(40)}`);
  search("before", LIMIT);
  search("before_all", 50);
  for (let i = 0; i < BETA_NODE_COUNT; i++) publishAndIndex(BETA, pad(`boundBeta${i.toString().padStart(2, "0")}`), "abc".repeat(60));
  search("after", LIMIT);
  search("after_all", 50);
  return { ops, revisionIds };
}

let runs: Record<string, Record<string, any>> = {};
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

async function run(name: string, fCount: number): Promise<void> {
  const fixture = await createFixture([ALPHA, BETA]);
  cleanups.push(fixture.cleanup);
  const { ops, revisionIds } = buildOps(fixture, fCount);
  const result = await runGated(fixture.datasetRoot, CHILD, [fixture.datasetRoot, JSON.stringify({ ops, revisionIds })], { deadlineMs: TIMEOUT_MS - 10_000 });
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
  const out = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);
  for (const op of ops) expect(out[op.label], `${name}/${op.label}: ${JSON.stringify(out[op.label])?.slice(0, 400)}`).toMatchObject({ ok: true });
  runs[name] = Object.fromEntries(Object.entries(out).map(([label, value]) => [label, (value as { value: unknown }).value]));
}
const ids = (answer: { hits: Hit[] }) => answer.hits.map((hit) => hit.node_id);

describe("#30 / #10 keyword order isolation holds up to the first overfetch round, and is measured past it (R22)", () => {
  runIt(
    `at the bound (${FIRST_ROUND} candidate chunks for limit ${LIMIT}): BETA-only writes never move ALPHA's answer`,
    async () => {
      await run("at", FIRST_ROUND - 1);
      const at = runs.at!;
      // Every ALPHA node answers, in R22's order (node id), both times.
      const all = [X, ...Array.from({ length: FIRST_ROUND - 1 }, (_, i) => f(i + 1))];
      expect(ids(at.before_all)).toEqual(all);
      expect(JSON.stringify(at.after_all)).toBe(JSON.stringify(at.before_all));
      // The bounded answer: R22's first, X, both times -- though BM25 ranks X
      // last before BETA writes and first after.
      expect(ids(at.before)).toEqual([X]);
      expect(JSON.stringify(at.after)).toBe(JSON.stringify(at.before));
    },
    TIMEOUT_MS,
  );

  runIt(
    `past the bound (${2 * FIRST_ROUND} candidate chunks for limit ${LIMIT}): which candidates enter can still follow BETA's writes -- the residual, measured`,
    async () => {
      await run("above", 2 * FIRST_ROUND - 1);
      const above = runs.above!;
      // Unbounded (limit 50 reads every candidate): still fully workspace-local.
      const all = [X, ...Array.from({ length: 2 * FIRST_ROUND - 1 }, (_, i) => f(i + 1))];
      expect(ids(above.before_all)).toEqual(all);
      expect(JSON.stringify(above.after_all)).toBe(JSON.stringify(above.before_all));
      // limit 1: the first round holds BM25's top 4 of ALPHA's 8 chunks. X is
      // BM25's last before BETA writes, so R22 picks the best of those F; once
      // BETA's corpus lifts X to BM25's first, X enters and is R22's first.
      // Every answer is still ALPHA's own nodes in R22's order -- the leak is
      // WHICH of them the bounded round saw.
      expect(ids(above.before)).toEqual([f(1)]);
      expect(ids(above.after)).toEqual([X]);
    },
    TIMEOUT_MS,
  );
});
