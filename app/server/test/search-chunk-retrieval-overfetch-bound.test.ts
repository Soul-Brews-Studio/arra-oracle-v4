/**
 * #30 / #10 keyword retrieval: R22's isolation BELOW the candidate ceiling
 * (docs/overnight/DECISIONS.md R22; the ceiling itself is measured in
 * `search-chunk-retrieval-candidate-ceiling.test.ts`).
 *
 * R22 lets BM25 over the shared FTS index SELECT candidate chunks and nothing
 * more. A candidate chunk is any chunk of the workspace sharing a trigram with
 * the query -- stale revisions, retired and superseded nodes and every
 * embedding profile included -- so it can outnumber the workspace's MATCHES
 * many times over. The keyword path therefore reads every candidate chunk in
 * one read of up to `FTS_CANDIDATE_CEILING`, orders the whole set by R22, and
 * only then keeps `limit`. Below the ceiling BM25 decides nothing: the answer
 * is a function of ALPHA's rows alone, BETA-only writes cannot move it, and a
 * bounded answer is the head of the unbounded one, byte for byte.
 *
 * Each corpus below is one on which the FIRST R22 cut -- stop as soon as
 * `limit` nodes survive a round of `limit * FTS_CANDIDATE_FACTOR` chunks in
 * BM25 order -- still leaked (fix-round verifier, reproduced red here):
 *
 *   ties     X plus 7 F nodes with byte-identical bodies (BM25 ties them),
 *            limit 1: 8 candidates against a round of 4. Which 4 LanceDB
 *            returned differed between identical fresh datasets (3 of 7 runs
 *            answered F2 or F3 instead of F1); no BETA write was needed.
 *   stale    X plus M, edited 3 times: 2 matches, 5 candidate chunks, limit 1.
 *            BETA-only writes moved the answer M -> X.
 *   default  X plus 10 M nodes each edited 3 times: 11 matches, 41 candidate
 *            chunks, the DEFAULT limit 10 (a round of 40). X, R22's first, was
 *            missing before BETA wrote and present after, and M00 dropped out.
 *
 * X is accepted last in `stale` and `default` (R22's second key), and holds
 * the smallest node id in `ties` (one fixed writer instant, so the third).
 * BETA's nodes never hold the query; they only shift the shared index's
 * corpus-wide statistics.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated } from "./helpers/publication-fixture";
import { FTS_CANDIDATE_CEILING } from "../src/fts/fts";
import { CHUNKER_VERSION, activeEmbeddingProfileId } from "../src/publication/search-chunk";

const CHILD = join(import.meta.dir, "fixtures", "search-chunk-v1", "core", "gated-retrieval.ts");
const TIMEOUT_MS = 120_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const PROFILE = activeEmbeddingProfileId();
const QUERY = "orderleakabcdef";
const T0 = 1_758_412_800_000;

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/search-chunk-v1/core/gated-retrieval.ts");
test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});
const runIt = MISSING.length > 0 ? test.skip : test;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const two = (i: number) => i.toString().padStart(2, "0");
const X = pad("boundA");
const X_BODY = `${QUERY} ${"def".repeat(40)} ${"xyz".repeat(2)}`;
const F_BODY = `${QUERY} ${"abc".repeat(40)}`;

type Hit = { node_id: string; rank: number; chunk_ids: string[] };
type Answer = { hits: Hit[] };
type Corpus = { limit: number | null; betaNodes: number; alpha: (publish: Publish) => void };
type Publish = (node: string, body: string, base?: string | null) => string;

/** The three corpora, each on its own fresh dataset. */
const CORPORA: Record<string, Corpus> = {
  ties: {
    limit: 1,
    betaNodes: 12,
    alpha: (publish) => {
      publish(X, X_BODY);
      for (let i = 1; i <= 7; i++) publish(pad(`boundF${two(i)}`), F_BODY);
    },
  },
  stale: {
    limit: 1,
    betaNodes: 12,
    alpha: (publish) => {
      let base: string | null = null;
      for (let i = 0; i < 3; i++) base = publish(pad("boundM"), `${F_BODY} x${"abc"[i]}`, base);
      publish(pad("boundM"), F_BODY, base);
      publish(X, X_BODY);
    },
  },
  default: {
    limit: null,
    betaNodes: 64,
    alpha: (publish) => {
      for (let n = 0; n < 10; n++) {
        let base: string | null = null;
        for (let i = 0; i < 3; i++) base = publish(pad(`boundM${two(n)}`), `${F_BODY} x${"abc"[i]}`, base);
        publish(pad(`boundM${two(n)}`), F_BODY, base);
      }
      publish(X, X_BODY);
    },
  },
};

const runs: Record<string, Record<string, any>> = {};
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

/** ALPHA's corpus; ALPHA searched; BETA writes; ALPHA searched again. */
async function run(name: string): Promise<Record<string, any>> {
  const corpus = CORPORA[name]!;
  const fixture = await createFixture([ALPHA, BETA]);
  cleanups.push(fixture.cleanup);
  const ops: unknown[] = [];
  const revisionIds: string[] = [];
  let clock = T0;
  const publisher =
    (workspace: string, stamped: boolean): Publish =>
    (node, body, base = null) => {
      const revision = pad(`r${node.slice(0, 16)}${revisionIds.length.toString().padStart(3, "0")}`);
      revisionIds.push(revision);
      ops.push({
        label: `pub_${revision}`,
        facade: "publication",
        method: "publishRevision",
        ...(stamped ? { clockMs: (clock += 1000) } : {}),
        request: { operation_id: `op-${revision}`, content: revisionEnvelope(workspace, fixture.workspaces[workspace]!, node, { title: "t", body, base_revision_id: base }) },
      });
      ops.push({
        label: `idx_${revision}`,
        facade: "context",
        method: "indexRevisionChunks",
        request: { workspace_name: workspace, node_id: node, revision_id: revision, chunker_version: CHUNKER_VERSION, embedding_profile: { name: PROFILE, dims: 384 } },
      });
      return revision;
    };
  const search = (label: string, limit: number | null) =>
    ops.push({ label, facade: "harness", method: "spyKeyword", request: { workspace_name: ALPHA, query: QUERY, ...(limit === null ? {} : { limit }) } });

  // `ties` keeps ONE writer instant, as the corpus it reproduces did.
  corpus.alpha(publisher(ALPHA, name !== "ties"));
  search("before", corpus.limit);
  search("before_all", 50);
  const beta = publisher(BETA, name !== "ties");
  for (let i = 0; i < corpus.betaNodes; i++) beta(pad(`boundBeta${two(i)}`), "abc".repeat(60));
  search("after", corpus.limit);
  search("after_all", 50);

  const result = await runGated(
    fixture.datasetRoot,
    CHILD,
    [fixture.datasetRoot, JSON.stringify({ ops, revisionIds, embedderProfile: PROFILE, queryVectors: {} })],
    { deadlineMs: TIMEOUT_MS - 10_000 },
  );
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
  const out = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);
  for (const op of ops as { label: string }[]) expect(out[op.label], `${name}/${op.label}: ${JSON.stringify(out[op.label])?.slice(0, 400)}`).toMatchObject({ ok: true });
  runs[name] = Object.fromEntries(Object.entries(out).map(([label, value]) => [label, (value as { value: unknown }).value]));
  return runs[name]!;
}
const answer = (spied: { value: Answer }) => spied.value;
const ids = (spied: { value: Answer }) => answer(spied).hits.map((hit) => hit.node_id);

/** What every corpus must show below the ceiling. */
function expectWorkspaceLocal(name: string, limit: number, expectedAll: string[]) {
  const r = runs[name]!;
  // The unbounded answer: every ALPHA match, in R22's order, before and after.
  expect(ids(r.before_all), `${name}: all`).toEqual(expectedAll);
  expect(JSON.stringify(answer(r.after_all)), `${name}: all after BETA`).toBe(JSON.stringify(answer(r.before_all)));
  // The bounded answer is the head of it, byte for byte, before and after.
  expect(answer(r.before).hits, `${name}: bounded = head`).toEqual(answer(r.before_all).hits.slice(0, limit));
  expect(JSON.stringify(answer(r.after)), `${name}: bounded after BETA`).toBe(JSON.stringify(answer(r.before)));
  // One candidate read, asked for the whole ceiling, came back short: every
  // candidate chunk was read, so BM25's pick among them decided nothing.
  for (const label of ["before", "before_all", "after", "after_all"]) {
    const reads = r[label].reads as { source: string; asked: number; got: number }[];
    expect(reads, `${name}/${label}`).toHaveLength(1);
    expect(reads[0], `${name}/${label}`).toMatchObject({ source: "index", asked: FTS_CANDIDATE_CEILING });
    expect(reads[0]!.got, `${name}/${label}`).toBeLessThan(FTS_CANDIDATE_CEILING);
  }
}

describe("#30 / #10 below the candidate ceiling, BETA-only writes never move ALPHA's keyword answer (R22)", () => {
  runIt(
    "ties: 8 candidates, BM25-tied bodies, limit 1 -- the answer is X on every run, before and after",
    async () => {
      await run("ties");
      expectWorkspaceLocal("ties", 1, [X, ...Array.from({ length: 7 }, (_, i) => pad(`boundF${two(i + 1)}`))]);
      expect(ids(runs.ties!.before)).toEqual([X]);
    },
    TIMEOUT_MS,
  );

  runIt(
    "stale: 2 matches but 5 candidate chunks (stale revisions), limit 1 -- X, before and after",
    async () => {
      await run("stale");
      expectWorkspaceLocal("stale", 1, [X, pad("boundM")]);
      expect(runs.stale!.before.reads[0].got).toBe(5);
      expect(ids(runs.stale!.after)).toEqual([X]);
    },
    TIMEOUT_MS,
  );

  runIt(
    "default: 11 matches, 41 candidate chunks, the default limit 10 -- the same ten, before and after",
    async () => {
      const r = await run("default");
      const ms = Array.from({ length: 10 }, (_, i) => pad(`boundM${two(9 - i)}`));
      expectWorkspaceLocal("default", 10, [X, ...ms]);
      expect(r.before.reads[0].got).toBe(41);
      expect(ids(r.before)).toEqual([X, ...ms.slice(0, 9)]);
      // #29 eligibility is asked only down R22's order: ten nodes, not eleven.
      expect(r.before.judged).toEqual([X, ...ms.slice(0, 9)]);
      expect(r.before_all.judged).toEqual([X, ...ms]);
    },
    TIMEOUT_MS,
  );
});
