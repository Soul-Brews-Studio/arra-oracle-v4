/**
 * #30 retrieval (overnight R7 #30 part + R14): the WRITER's maintenance of the
 * chunk-text index, on a real writer-gated dataset (same child as
 * `search-chunk-retrieval.test.ts`).
 *
 * 1. A failed index build is not a poisoned owner. The build is made to fail
 *    FOR REAL -- the table's `_indices` directory is not writable, while row
 *    appends (`data/`, `_versions/`) still land -- on the fresh `indexed` path,
 *    AFTER the chunk rows are durable. The call answers `writer_unavailable`;
 *    the rows are there; the next publication and the next index call are
 *    served normally (not `recovery_required`); once the directory is
 *    writable again, a replay repeats only the index step and search uses it.
 * 2. The index does not go stale forever: rows appended after a build are
 *    searched unindexed only until they outnumber the indexed ones, when the
 *    writer's next index step rebuilds it over every row.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated } from "./helpers/publication-fixture";
import { CHUNKER_VERSION, activeEmbeddingProfileId } from "../src/publication/search-chunk";

const CHILD = join(import.meta.dir, "fixtures", "search-chunk-v1", "core", "gated-retrieval.ts");
const TIMEOUT_MS = 180_000;
const ALPHA = "alpha-workspace";
// #30 R7 (search-embed): the closed registry accepts only its active id.
const PROFILE = activeEmbeddingProfileId();

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/search-chunk-v1/core/gated-retrieval.ts");
test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});
const runIt = MISSING.length > 0 ? test.skip : test;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
/** Nodes, in publish order; revision ids are minted in that order. */
const KEYS = ["a", "b", "c", "d", "e", "f", "g", "h", "i"] as const;
const NODE = Object.fromEntries(KEYS.map((k) => [k, pad(`mtNode${k}`)])) as Record<(typeof KEYS)[number], string>;
const REV = Object.fromEntries(KEYS.map((k) => [k, pad(`mtRev${k}`)])) as Record<(typeof KEYS)[number], string>;

let out: Record<string, any> = {};
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});
const result = (label: string) => out[label];
const ok = (label: string) => {
  expect(out[label], `${label}: ${JSON.stringify(out[label])}`).toMatchObject({ ok: true });
  return out[label].value;
};
/** The rebuild steps run AFTER index calls b..i; see the setup op list. */
const GROWTH = ["c", "e", "f", "g", "h", "i"] as const;

describe("#30 the writer's chunk-text index maintenance (real gated dataset)", () => {
  runIt(
    "setup",
    async () => {
      const fixture = await createFixture([ALPHA]);
      cleanups.push(fixture.cleanup);
      const alpha = fixture.workspaces[ALPHA]!;
      const ops: unknown[] = [];
      const publish = (k: (typeof KEYS)[number]) =>
        ops.push({
          label: `pub_${k}`,
          facade: "publication",
          method: "publishRevision",
          request: { operation_id: `op-${k}`, content: revisionEnvelope(ALPHA, alpha, NODE[k], { title: `note ${k}`, body: `หลงลืม marker-${k}` }) },
        });
      const index = (label: string, k: (typeof KEYS)[number]) =>
        ops.push({
          label,
          facade: "context",
          method: "indexRevisionChunks",
          request: {
            workspace_name: ALPHA,
            node_id: NODE[k],
            revision_id: REV[k],
            chunker_version: CHUNKER_VERSION,
            embedding_profile: { name: PROFILE, dims: 384 },
          },
        });
      const harness = (label: string, method: string) => ops.push({ label, facade: "harness", method });
      const list = (label: string, k: (typeof KEYS)[number]) =>
        ops.push({
          label,
          facade: "reader",
          method: "listSearchChunks",
          request: { workspace_name: ALPHA, revision_id: REV[k], chunker_version: CHUNKER_VERSION, embedding_profile: PROFILE },
        });

      publish("a");
      publish("b");
      // ── 1. a failed build on the fresh `indexed` path ──────────────────
      harness("lock", "lockIndexDir");
      index("idx_a_locked", "a");
      list("rows_a_after_failure", "a");
      publish("c"); // the owner still serves the next publication ...
      index("idx_b_locked", "b"); // ... and the next index call
      harness("indices_while_locked", "listIndices");
      harness("unlock", "unlockIndexDir");
      index("idx_a_replay", "a");
      harness("indices_after_replay", "listIndices");
      harness("stats_after_replay", "indexStats");
      ops.push({ label: "kw_after_replay", facade: "reader", method: "searchKnowledgeKeyword", request: { workspace_name: ALPHA, query: "marker-a" } });

      // ── 2. growth: never more unindexed rows than indexed ones ─────────
      for (const k of ["d", "e", "f", "g", "h", "i"] as const) publish(k);
      for (const k of GROWTH) {
        index(`idx_${k}`, k);
        harness(`stats_${k}`, "indexStats");
      }

      const run = await runGated(
        fixture.datasetRoot,
        CHILD,
        [fixture.datasetRoot, JSON.stringify({ ops, revisionIds: KEYS.map((k) => REV[k]), embedderProfile: PROFILE, queryVectors: {} })],
        { deadlineMs: TIMEOUT_MS - 10_000 },
      );
      if (run.code !== 0) throw new Error(`child exited ${run.code}: ${run.stderr.slice(0, 2000)}`);
      out = JSON.parse(run.stdout.trim().split("\n").filter(Boolean).at(-1)!);
      for (const k of KEYS) expect(ok(`pub_${k}`).revision_id).toBe(REV[k]);
    },
    TIMEOUT_MS,
  );

  runIt("a failed index build answers writer_unavailable and leaves the owner serving", () => {
    expect(result("idx_a_locked")).toMatchObject({ ok: false, code: "writer_unavailable" });
    // The chunk rows were already durable when the build failed.
    expect(ok("rows_a_after_failure")).toHaveLength(1);
    // NOT recovery_required: the next publication and index call are served;
    // the index call fails the same honest way while the directory is locked.
    expect(ok("pub_c").outcome).toBe("accepted");
    expect(result("idx_b_locked")).toMatchObject({ ok: false, code: "writer_unavailable" });
    expect(ok("indices_while_locked")).toEqual([]);
  });

  runIt("a replay repeats only the index step, and search then uses the index", () => {
    expect(ok("idx_a_replay").outcome).toBe("already_satisfied");
    expect(ok("indices_after_replay")).toHaveLength(1);
    expect(ok("indices_after_replay")[0]).toMatchObject({ base_tokenizer: "ngram", min_ngram_length: 3, max_ngram_length: 3 });
    // Rows of a AND b (b's chunks landed before its own build failed).
    expect(ok("stats_after_replay")).toEqual({ indexed: 2, unindexed: 0 });
    const kw = ok("kw_after_replay");
    expect(kw.match).toBe("ngram");
    expect(kw.hits.map((hit: { node_id: string }) => hit.node_id)).toEqual([NODE.a]);
  });

  runIt("rows appended after a build never outnumber the indexed ones: the writer rebuilds", () => {
    const seen = GROWTH.map((k) => ok(`stats_${k}`) as { indexed: number; unindexed: number });
    for (const [i, stats] of seen.entries()) {
      expect(stats.indexed + stats.unindexed, GROWTH[i]).toBe(3 + i);
      expect(stats.unindexed, `${GROWTH[i]}: ${JSON.stringify(stats)}`).toBeLessThan(stats.indexed);
    }
    // At least one rebuild happened after the replay's build over 2 rows.
    expect(Math.max(...seen.map((stats) => stats.indexed))).toBeGreaterThan(2);
  });
});
