/**
 * #30 coverage: a search answer says when its candidate read hit the bound
 * (docs/overnight/DECISIONS.md R22 "Known residual"; `search-chunk-v1.md`
 * section 21). Before this, a caller could not tell a complete answer from
 * one cut at `FTS_CANDIDATE_CEILING` (4096) candidate chunks.
 *
 * Every answer now carries three closed fields: `coverage` ("full" |
 * "partial"), `coverage_reason` ("candidate_ceiling" | null) and
 * `candidate_ceiling` (the bound itself). Building 4096 real candidate chunks
 * per case would cost megabytes per run (the ceiling test does it once, to
 * MEASURE the residual), so here the ceiling is injected through the harness
 * op `searchAtCeiling` -- a test-only argument production never passes -- and
 * the default path is checked to report 4096 and "full".
 *
 *   keyword  ALPHA: A1..A3 hold the query; A4 shares only a trigram with it
 *            (a candidate chunk, never an answer). BETA: 6 nodes holding the
 *            query -- more than ALPHA's ceiling -- which must never flip
 *            ALPHA's coverage: the reads are prefiltered to the workspace, so
 *            the signal counts ALPHA's own rows only.
 *   scan     a 2-code-point query (the short-query scan) against the same
 *            nodes: its own read, its own bound.
 *   semantic S edited once, both revisions embedded -- its stale chunk is
 *            the nearest, and a candidate that never answers -- plus T,
 *            farther. At a ceiling of 2 the loop reads S's two chunks, keeps
 *            one node of the two asked for, and cannot read on: partial.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated } from "./helpers/publication-fixture";
import { FTS_CANDIDATE_CEILING } from "../src/fts/fts";
import { CHUNKER_VERSION, activeEmbeddingProfileId, deriveChunkId } from "../src/publication/search-chunk";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = join(import.meta.dir, "fixtures", "search-chunk-v1", "core", "gated-retrieval.ts");
const TIMEOUT_MS = testTimeout(120_000);
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const PROFILE = activeEmbeddingProfileId();
const DIMS = 384;
const QUERY = "covqzx";
const SHORT = "qz";

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/search-chunk-v1/core/gated-retrieval.ts");
test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});
const runIt = MISSING.length > 0 ? test.skip : test;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const unit = (...weights: [number, number][]) => {
  const v = new Array<number>(DIMS).fill(0);
  for (const [index, weight] of weights) v[index] = weight;
  return v;
};
const E0 = unit([0, 1]);
const E1 = unit([1, 1]);
const MIX = unit([0, Math.SQRT1_2], [1, Math.SQRT1_2]);
const chunk = (revisionId: string) => deriveChunkId(revisionId, CHUNKER_VERSION, PROFILE, 0n);

const A = [1, 2, 3].map((i) => pad(`covA${i}`));
const A4 = pad("covA4");
const S = pad("covS");
const T = pad("covT");

type Answer = { coverage: string; coverage_reason: string | null; candidate_ceiling: number; hits: { node_id: string }[] };

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

let out: Record<string, { ok: boolean; value: Answer }> = {};
const answer = (label: string) => {
  expect(out[label]?.ok, `${label}: ${JSON.stringify(out[label])?.slice(0, 400)}`).toBe(true);
  return out[label]!.value;
};
const signal = (label: string) => {
  const { coverage, coverage_reason, candidate_ceiling } = answer(label);
  return { coverage, coverage_reason, candidate_ceiling };
};
const ids = (label: string) => answer(label).hits.map((hit) => hit.node_id);
const FULL = (ceiling: number) => ({ coverage: "full", coverage_reason: null, candidate_ceiling: ceiling });
const PARTIAL = (ceiling: number) => ({ coverage: "partial", coverage_reason: "candidate_ceiling", candidate_ceiling: ceiling });

describe("#30 search answers disclose a saturated candidate read (R22 residual)", () => {
  runIt(
    "setup: publish, index and embed land; every search answers",
    async () => {
      const fixture = await createFixture([ALPHA, BETA]);
      cleanups.push(fixture.cleanup);
      const ops: unknown[] = [];
      const revisionIds: string[] = [];
      const publish = (workspace: string, node: string, body: string, base: string | null = null) => {
        const revision = pad(`rc${node.slice(0, 12)}${revisionIds.length.toString().padStart(2, "0")}`);
        revisionIds.push(revision);
        ops.push({
          label: `pub_${revision}`,
          facade: "publication",
          method: "publishRevision",
          request: { operation_id: `op-${revision}`, content: revisionEnvelope(workspace, fixture.workspaces[workspace]!, node, { title: "t", body, base_revision_id: base }) },
        });
        ops.push({
          label: `idx_${revision}`,
          facade: "context",
          method: "indexRevisionChunks",
          request: { workspace_name: workspace, node_id: node, revision_id: revision, chunker_version: CHUNKER_VERSION, embedding_profile: { name: PROFILE, dims: DIMS } },
        });
        return revision;
      };
      const embed = (workspace: string, revision: string, vector: number[]) =>
        ops.push({ label: `emb_${revision}`, facade: "context", method: "writeChunkEmbedding", request: { workspace_name: workspace, id: chunk(revision), embedding: vector } });
      const at = (label: string, ceiling: number, method: "keyword" | "semantic", request: Record<string, unknown>) =>
        ops.push({ label, facade: "harness", method: "searchAtCeiling", request: { ceiling, method, request: { workspace_name: ALPHA, ...request } } });

      for (let i = 0; i < 6; i++) publish(BETA, pad(`covBeta${i}`), `${QUERY} beta ${i}`);
      A.forEach((node, i) => publish(ALPHA, node, `${QUERY} alpha ${i}`));
      at("kw_below", 4, "keyword", { query: QUERY, limit: 50 });
      at("kw_beta", 4, "keyword", { query: QUERY, limit: 50, workspace_name: BETA });
      ops.push({ label: "kw_default", facade: "reader", method: "searchKnowledgeKeyword", request: { workspace_name: ALPHA, query: QUERY, limit: 50 } });
      at("scan_at", 3, "keyword", { query: SHORT, limit: 50 });
      at("scan_below", 4, "keyword", { query: SHORT, limit: 50 });
      at("scan_over", 2, "keyword", { query: SHORT, limit: 50 });

      publish(ALPHA, A4, "covq only, never the whole query");
      at("kw_at", 4, "keyword", { query: QUERY, limit: 50 });
      at("kw_at_limit1", 4, "keyword", { query: QUERY, limit: 1 });
      at("kw_above", 5, "keyword", { query: QUERY, limit: 50 });

      const s1 = publish(ALPHA, S, "semantic one");
      embed(ALPHA, s1, E0);
      const s2 = publish(ALPHA, S, "semantic two", s1);
      embed(ALPHA, s2, MIX);
      embed(ALPHA, publish(ALPHA, T, "semantic three"), E1);
      at("sem_partial", 2, "semantic", { query: "q-e0", limit: 2 });
      at("sem_full", 3, "semantic", { query: "q-e0", limit: 2 });
      at("sem_dry", 4, "semantic", { query: "q-e0", limit: 3 });
      ops.push({ label: "sem_default", facade: "reader", method: "searchKnowledgeSemantic", request: { workspace_name: ALPHA, query: "q-e0", limit: 2 } });

      const result = await runGated(
        fixture.datasetRoot,
        CHILD,
        [fixture.datasetRoot, JSON.stringify({ ops, revisionIds, embedderProfile: PROFILE, queryVectors: { "q-e0": E0 } })],
        { deadlineMs: TIMEOUT_MS - 10_000 },
      );
      if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
      out = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);
      for (const op of ops as { label: string }[]) expect(out[op.label]?.ok, `${op.label}: ${JSON.stringify(out[op.label])?.slice(0, 400)}`).toBe(true);
    },
    TIMEOUT_MS,
  );

  runIt("keyword: below the ceiling every candidate is read -- full, whatever another workspace holds", () => {
    expect(signal("kw_below")).toEqual(FULL(4));
    expect(ids("kw_below")).toEqual(A);
    // BETA holds 6 candidates against the same ceiling: ITS answer is partial,
    // and that never reaches ALPHA's.
    expect(signal("kw_beta")).toEqual(PARTIAL(4));
    // The default path states the real bound.
    expect(signal("kw_default")).toEqual(FULL(FTS_CANDIDATE_CEILING));
    expect(ids("kw_default")).toEqual(A);
  });

  runIt("keyword: a read that comes back with exactly the ceiling cannot tell -- partial, counting chunks not matches", () => {
    // 3 matches, but A4 shares a trigram: 4 candidate chunks at a ceiling of 4.
    expect(signal("kw_at")).toEqual(PARTIAL(4));
    expect(ids("kw_at")).toEqual(A);
    // `limit` is paging, not coverage: the flag is about the read, at any limit.
    expect(signal("kw_at_limit1")).toEqual(PARTIAL(4));
    expect(ids("kw_at_limit1")).toEqual([A[0]]);
    expect(signal("kw_above")).toEqual(FULL(5));
  });

  runIt("keyword: the short-query scan reports its own read's bound", () => {
    expect(answer("scan_at")).toMatchObject({ match: "substring_scan", scan_reason: "short_query" });
    expect(signal("scan_at")).toEqual(PARTIAL(3));
    expect(signal("scan_below")).toEqual(FULL(4));
    expect(ids("scan_below")).toEqual(A);
    // The flag describes the read the answer came from: at a ceiling of 2 the
    // scan read the first 2 chunks by node id, and A3 was never considered.
    expect(signal("scan_over")).toEqual(PARTIAL(2));
    expect(ids("scan_over")).toEqual(A.slice(0, 2));
  });

  runIt("semantic: the overfetch loop hitting the ceiling short of limit is partial; a dry source is not", () => {
    // Reads S's stale chunk and its head chunk, keeps S only, may not read on.
    expect(signal("sem_partial")).toEqual(PARTIAL(2));
    expect(ids("sem_partial")).toEqual([S]);
    expect(signal("sem_full")).toEqual(FULL(3));
    expect(ids("sem_full")).toEqual([S, T]);
    // Three ready chunks in all: the read came back short of the ceiling.
    expect(signal("sem_dry")).toEqual(FULL(4));
    expect(ids("sem_dry")).toEqual([S, T]);
    expect(signal("sem_default")).toEqual(FULL(FTS_CANDIDATE_CEILING));
    expect(ids("sem_default")).toEqual([S, T]);
  });

  runIt("no raw score and no count cross the wire: the signal is three closed fields", () => {
    for (const label of ["kw_below", "kw_at", "scan_at", "sem_partial", "sem_full"]) {
      const value = answer(label) as Record<string, unknown>;
      expect(Object.keys(value).filter((key) => key !== "hits").sort(), label).toEqual(
        (label.startsWith("sem")
          ? ["candidate_ceiling", "coverage", "coverage_reason", "embedding_profile", "metric"]
          : ["candidate_ceiling", "coverage", "coverage_reason", "match", "scan_reason"]
        ).sort(),
      );
    }
  });
});
