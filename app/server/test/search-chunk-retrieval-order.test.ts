/**
 * #30 / #10 keyword hit ORDER on a real writer-gated dataset -- overnight R22
 * (docs/overnight/DECISIONS.md). The pure keys are pinned in
 * `search-chunk-retrieval-order-key.test.ts`; this file proves the service
 * answers in that order, on every path a keyword answer can take:
 *
 * - `ix_*`    the trigram index (`match: "ngram"`);
 * - `short_*` a 2-code-point query, the short-query scan (`scan_reason:
 *             "short_query"`);
 * - `scan_*`  the same queries with the index dropped (`"index_unavailable"`).
 *
 * The corpus is built so that the order R22 asks for is NOT the order BM25
 * or node id would give (red before R22):
 *
 *   MANY   "Kettle notes" / "kettle and KETTLE."  3 folded occurrences, the
 *          OLDEST head, the LARGEST node id -- first anyway (key 1);
 *   NEWER  one occurrence, accepted 2 s after TIE_A/TIE_B -- ahead of them
 *          (key 2), though its node id sorts after theirs;
 *   TIE_A, TIE_B  one occurrence, the same instant, the same text (so BM25
 *          cannot tell them apart either) -- node id (key 3).
 *   NONE   holds no occurrence; never a hit.
 *
 * Then two new HEADS are published: TIE_B's with five occurrences, TIE_A's
 * with one but accepted last. Occurrences and acceptance are read from the
 * CURRENT head (the stale chunks of the first revisions count for nothing),
 * and the scan paths, asked after the index is dropped, answer in the
 * identical order with identical hits.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated } from "./helpers/publication-fixture";
import { CHUNKER_VERSION, activeEmbeddingProfileId } from "../src/publication/search-chunk";

const CHILD = join(import.meta.dir, "fixtures", "search-chunk-v1", "core", "gated-retrieval.ts");
const TIMEOUT_MS = 120_000;
const ALPHA = "alpha-workspace";
const PROFILE = activeEmbeddingProfileId();
/** Acceptance instants, whole milliseconds (the store refuses sub-ms, R1). */
const T0 = 1_758_412_800_000;

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/search-chunk-v1/core/gated-retrieval.ts");
test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});
const runIt = MISSING.length > 0 ? test.skip : test;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
// Node ids chosen so node-id order is the REVERSE of what keys 1 and 2 decide.
const N = { many: pad("ordZMany"), newer: pad("ordYNewer"), tieA: pad("ordATie"), tieB: pad("ordBTie"), none: pad("ordNone") };
const R = {
  many: pad("ordRevMany"),
  tieA: pad("ordRevTieA"),
  tieB: pad("ordRevTieB"),
  newer: pad("ordRevNewer"),
  none: pad("ordRevNone"),
  tieB2: pad("ordRevTieB2"),
  tieA2: pad("ordRevTieA2"),
};
/** In publish order: the child mints revision ids from this list. */
const REVISIONS = [R.many, R.tieA, R.tieB, R.newer, R.none, R.tieB2, R.tieA2];
const ONE = "one kettle here, padded.";

type Hit = { node_id: string; revision_id: string; title: string; snippet: string; chunk_ids: string[]; rank: number; match: string };
let out: Record<string, any> = {};
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});
const ok = (label: string) => {
  expect(out[label], `${label}: ${JSON.stringify(out[label])?.slice(0, 600)}`).toMatchObject({ ok: true });
  return out[label].value;
};
const nodes = (label: string) => (ok(label).hits as Hit[]).map((hit) => hit.node_id);
/** A hit minus HOW it was found: what two paths must agree on. */
const found = (label: string) => (ok(label).hits as Hit[]).map(({ match: _match, ...rest }) => rest);

describe("#30 / #10 keyword hit order is workspace-local (R22), on the index and on both scans", () => {
  runIt(
    "setup: publish, index, search on every path",
    async () => {
      const fixture = await createFixture([ALPHA]);
      cleanups.push(fixture.cleanup);
      const alpha = fixture.workspaces[ALPHA]!;
      const ops: unknown[] = [];
      const publish = (key: string, node: string, title: string, body: string, clockMs: number, base: string | null = null) =>
        ops.push({
          label: `pub_${key}`,
          facade: "publication",
          method: "publishRevision",
          clockMs,
          request: { operation_id: `op-${key}`, content: revisionEnvelope(ALPHA, alpha, node, { title, body, base_revision_id: base }) },
        });
      const index = (key: string, node: string, revision: string) =>
        ops.push({
          label: `idx_${key}`,
          facade: "context",
          method: "indexRevisionChunks",
          request: { workspace_name: ALPHA, node_id: node, revision_id: revision, chunker_version: CHUNKER_VERSION, embedding_profile: { name: PROFILE, dims: 384 } },
        });
      const keyword = (label: string, query: string, extra: Record<string, unknown> = {}) =>
        ops.push({ label, facade: "reader", method: "searchKnowledgeKeyword", request: { workspace_name: ALPHA, query, ...extra } });

      publish("many", N.many, "Kettle notes", "kettle and KETTLE.", T0);
      publish("tieA", N.tieA, "t", ONE, T0 + 1000);
      publish("tieB", N.tieB, "t", ONE, T0 + 1000);
      publish("newer", N.newer, "t", ONE, T0 + 3000);
      publish("none", N.none, "t", "no such word here at all.", T0 + 4000);
      index("many", N.many, R.many);
      index("tieA", N.tieA, R.tieA);
      index("tieB", N.tieB, R.tieB);
      index("newer", N.newer, R.newer);
      index("none", N.none, R.none);

      keyword("ix_first", "kettle");
      keyword("ix_first_again", "kettle");
      keyword("ix_first_upper", "KETTLE");
      keyword("ix_first_limit2", "kettle", { limit: 2 });
      keyword("short_first", "kE");

      // New heads: TIE_B now holds five occurrences, TIE_A one but accepted
      // last. Their first revisions' chunks stay behind, stale.
      publish("tieB2", N.tieB, "t", "kettle kettle kettle kettle kettle", T0 + 5000, R.tieB);
      publish("tieA2", N.tieA, "t", "one kettle here, padded!", T0 + 6000, R.tieA);
      index("tieB2", N.tieB, R.tieB2);
      index("tieA2", N.tieA, R.tieA2);

      keyword("ix_head", "kettle");
      keyword("ix_head_limit2", "kettle", { limit: 2 });
      keyword("short_head", "kE");
      keyword("short_head_limit2", "kE", { limit: 2 });
      ops.push({ label: "drop", facade: "harness", method: "dropIndices" });
      keyword("scan_head", "kettle");
      keyword("scan_head_limit2", "kettle", { limit: 2 });

      const result = await runGated(
        fixture.datasetRoot,
        CHILD,
        [fixture.datasetRoot, JSON.stringify({ ops, revisionIds: REVISIONS, embedderProfile: PROFILE, queryVectors: {} })],
        { deadlineMs: TIMEOUT_MS - 10_000 },
      );
      if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
      out = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);
      for (const key of ["many", "tieA", "tieB", "newer", "none", "tieB2", "tieA2"]) {
        ok(`pub_${key}`);
        ok(`idx_${key}`);
      }
      expect(ok("pub_tieB2").revision_id).toBe(R.tieB2);
      expect(ok("pub_tieA2").revision_id).toBe(R.tieA2);
    },
    TIMEOUT_MS,
  );

  runIt("index path: occurrences first, then the later-accepted head, then node id", () => {
    const first = ok("ix_first");
    expect(first.match).toBe("ngram");
    expect(nodes("ix_first")).toEqual([N.many, N.newer, N.tieA, N.tieB]);
    // rank is the position in THAT order.
    expect((first.hits as Hit[]).map((hit) => hit.rank)).toEqual([1, 2, 3, 4]);
    for (const hit of first.hits as Hit[]) expect(hit.match).toBe("ngram");
    // Stable, and case-folded on both sides: KETTLE counts the same words.
    expect(ok("ix_first_again")).toEqual(first);
    expect(nodes("ix_first_upper")).toEqual(nodes("ix_first"));
    // A bounded limit keeps the head of THIS order, not of BM25's.
    expect(nodes("ix_first_limit2")).toEqual([N.many, N.newer]);
  });

  runIt("short-query scan: the same order", () => {
    const short = ok("short_first");
    expect(short).toMatchObject({ match: "substring_scan", scan_reason: "short_query" });
    expect(nodes("short_first")).toEqual([N.many, N.newer, N.tieA, N.tieB]);
    expect((short.hits as Hit[]).map((hit) => hit.rank)).toEqual([1, 2, 3, 4]);
  });

  runIt("the keys are read from the CURRENT head: a new head moves its node, a stale chunk counts for nothing", () => {
    // TIE_B's head holds 5 occurrences; TIE_A's single one is now the latest-accepted.
    const expected = [N.tieB, N.many, N.tieA, N.newer];
    expect(ok("ix_head").match).toBe("ngram");
    expect(nodes("ix_head")).toEqual(expected);
    const byNode = new Map((ok("ix_head").hits as Hit[]).map((hit) => [hit.node_id, hit]));
    expect(byNode.get(N.tieB)!.revision_id).toBe(R.tieB2);
    expect(byNode.get(N.tieA)!.revision_id).toBe(R.tieA2);
    expect(nodes("ix_head_limit2")).toEqual([N.tieB, N.many]);
    expect(ok("short_head")).toMatchObject({ match: "substring_scan", scan_reason: "short_query" });
    expect(nodes("short_head")).toEqual(expected);
    expect(nodes("short_head_limit2")).toEqual([N.tieB, N.many]);
  });

  runIt("index-unavailable scan: the identical hits in the identical order as the index path", () => {
    const scan = ok("scan_head");
    expect(scan).toMatchObject({ match: "substring_scan", scan_reason: "index_unavailable" });
    expect(nodes("scan_head")).toEqual([N.tieB, N.many, N.tieA, N.newer]);
    // Everything but how each hit was found is the same answer.
    expect(found("scan_head")).toEqual(found("ix_head"));
    expect(found("scan_head_limit2")).toEqual(found("ix_head_limit2"));
  });
});
