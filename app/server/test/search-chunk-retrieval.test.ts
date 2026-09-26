/**
 * #30 retrieval over the target-19 knowledge tier (overnight R7 #30 part +
 * R14, docs/overnight/DECISIONS.md): `searchKnowledgeKeyword` and
 * `searchKnowledgeSemantic` on the context READER, against a real writer-gated
 * dataset created by the accepted Python exporter.
 *
 * One gated child (`fixtures/search-chunk-v1/core/gated-retrieval.ts`) runs the
 * whole script: publish -> indexRevisionChunks -> writeChunkEmbedding (stub
 * vectors) -> lifecycle -> searches on the reader. Every assertion lives here.
 *
 * What each case pins, and why it is the discriminating one:
 * - ลืม inside หลงลืม: the inside-word Thai case `icu` measurably misses (#10).
 * - หลงทาง: shares the trigram หลง with หลงลืม, so a trigram index alone
 *   over-matches; substring post-verification must drop it (R14). Every text
 *   here fits one chunk, so the chunk-local pre-filter already does; the case
 *   only the whole-head-text re-check can refuse (an over-match cut at a chunk
 *   seam) is in `search-chunk-retrieval-straddle.test.ts`.
 * - a 2-code-point query has no trigram to look up: it must be the bounded
 *   scan, and say so (`match: "substring_scan"`).
 * - retired / superseded / stale-revision / other-workspace / pending rows are
 *   each present in search_chunks_v1 and MUST NOT surface; so is a chunk that
 *   keeps a vector but is not `ready` (made by test-side surgery).
 * - semantic ranking uses stub vectors whose squared-L2 distances are known.
 * - a node indexed ONLY under another embedding profile, sitting exactly at
 *   the query vector, never answers the default profile's search: vector
 *   spaces are never mixed. A reader whose embedder serves that other profile
 *   answers it by default, since the default is the embedder's own profile.
 * - the candidate query itself is workspace-scoped (a spying adapter records
 *   every candidate), not only the follow-up head/eligibility reads.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { CHUNKER_VERSION, activeEmbeddingProfileId, deriveChunkId } from "../src/publication/search-chunk";

const CHILD = join(import.meta.dir, "fixtures", "search-chunk-v1", "core", "gated-retrieval.ts");
const TIMEOUT_MS = 180_000;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
// #30 R7 (search-embed): the closed registry accepts only its active id.
const PROFILE = activeEmbeddingProfileId();
// A non-active profile id, as a since-retired profile's rows would carry.
const OTHER_PROFILE = "ollama/other-model/384/none";
const DIMS = 384;

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
const E2 = unit([2, 1]);
const MIX = unit([0, Math.SQRT1_2], [1, Math.SQRT1_2]);

// Nodes, in publish order. Revision ids are minted from REVISIONS in the same
// order, so every id -- and therefore every derived chunk id -- is known here.
const N = {
  thai: pad("srchThai"),
  fox: pad("srchFox"),
  mix: pad("srchMix"),
  retired: pad("srchRetired"),
  old: pad("srchOld"),
  successor: pad("srchNew"),
  stale: pad("srchStale"),
  pending: pad("srchPending"),
  beta: pad("srchBeta"),
  other: pad("srchOther"),
  failed: pad("srchFailed"),
};
const R = {
  thai: pad("revThai"),
  fox: pad("revFox"),
  mix: pad("revMix"),
  retired: pad("revRetired"),
  old: pad("revOld"),
  successor: pad("revNew"),
  stale1: pad("revStale1"),
  pending: pad("revPending"),
  beta: pad("revBeta"),
  other: pad("revOther"),
  failed: pad("revFailed"),
  stale2: pad("revStale2"),
};
const REVISIONS = [R.thai, R.fox, R.mix, R.retired, R.old, R.successor, R.stale1, R.pending, R.beta, R.other, R.failed, R.stale2];
const chunk = (revisionId: string, profile = PROFILE) => deriveChunkId(revisionId, CHUNKER_VERSION, profile, 0n);

type Op = { label: string; facade: "publication" | "context" | "reader" | "reader_other" | "harness"; method: string; request?: unknown };

function buildOps(fixture: Fixture): Op[] {
  const alpha = fixture.workspaces[ALPHA]!;
  const beta = fixture.workspaces[BETA]!;
  const ops: Op[] = [];
  const publish = (label: string, workspace: string, seeded: typeof alpha, node: string, title: string, body: string, base: string | null = null) =>
    ops.push({
      label,
      facade: "publication",
      method: "publishRevision",
      request: {
        operation_id: `op-${label}`,
        content: revisionEnvelope(workspace, seeded, node, { title, body, base_revision_id: base }),
      },
    });
  const index = (label: string, workspace: string, node: string, revision: string, profile = PROFILE) =>
    ops.push({
      label,
      facade: "context",
      method: "indexRevisionChunks",
      request: {
        workspace_name: workspace,
        node_id: node,
        revision_id: revision,
        chunker_version: CHUNKER_VERSION,
        embedding_profile: { name: profile, dims: DIMS },
      },
    });
  const embed = (label: string, workspace: string, revision: string, vector: number[], profile = PROFILE) =>
    ops.push({ label, facade: "context", method: "writeChunkEmbedding", request: { workspace_name: workspace, id: chunk(revision, profile), embedding: vector } });
  const keyword = (label: string, query: string, extra: Record<string, unknown> = {}, workspace = ALPHA) =>
    ops.push({ label, facade: "reader", method: "searchKnowledgeKeyword", request: { workspace_name: workspace, query, ...extra } });
  const semantic = (label: string, query: string, extra: Record<string, unknown> = {}, workspace = ALPHA) =>
    ops.push({ label, facade: "reader", method: "searchKnowledgeSemantic", request: { workspace_name: workspace, query, ...extra } });
  const harness = (label: string, method: string, request?: unknown) => ops.push({ label, facade: "harness", method, request });

  publish("pub_thai", ALPHA, alpha, N.thai, "บันทึก", "ฉันหลงลืมกุญแจไว้ที่บ้าน");
  publish("pub_fox", ALPHA, alpha, N.fox, "fox note", "the quick brown fox jumps");
  publish("pub_mix", ALPHA, alpha, N.mix, "trip", "เราไปทะเลกัน");
  publish("pub_retired", ALPHA, alpha, N.retired, "retired note", "หลงลืม retired-marker");
  publish("pub_old", ALPHA, alpha, N.old, "old note", "หลงลืม superseded-marker");
  publish("pub_successor", ALPHA, alpha, N.successor, "successor note", "successor-marker");
  publish("pub_stale1", ALPHA, alpha, N.stale, "stale note", "zebrafish หลงลืม");
  publish("pub_pending", ALPHA, alpha, N.pending, "pending note", "หลงลืม pending-marker");
  publish("pub_beta", BETA, beta, N.beta, "beta note", "ฉันหลงลืมกุญแจไว้ที่บ้าน beta-marker");
  publish("pub_other", ALPHA, alpha, N.other, "profile note", "other-profile-marker");
  publish("pub_failed", ALPHA, alpha, N.failed, "failed note", "failed-embed-marker");

  // Before any chunk index call: the reader answers, never builds an index.
  harness("indices_before", "listIndices");
  keyword("kw_before_index", "ลืม");
  harness("indices_after_reader", "listIndices");

  for (const [label, workspace, node, revision] of [
    ["idx_thai", ALPHA, N.thai, R.thai],
    ["idx_fox", ALPHA, N.fox, R.fox],
    ["idx_mix", ALPHA, N.mix, R.mix],
    ["idx_retired", ALPHA, N.retired, R.retired],
    ["idx_old", ALPHA, N.old, R.old],
    ["idx_successor", ALPHA, N.successor, R.successor],
    ["idx_stale1", ALPHA, N.stale, R.stale1],
    ["idx_pending", ALPHA, N.pending, R.pending],
    ["idx_beta", BETA, N.beta, R.beta],
    ["idx_failed", ALPHA, N.failed, R.failed],
  ] as const) index(label, workspace, node, revision);
  // Indexed and embedded ONLY under another profile, AT the query vector.
  // The closed registry (#30 R7) indexes only under the active profile, so
  // the row is indexed there and then moved onto OTHER_PROFILE by surgery --
  // the state a row written under a since-retired profile id is in.
  index("idx_other", ALPHA, N.other, R.other);
  ops.push({
    label: "idx_other_relabel",
    facade: "harness",
    method: "relabelChunkProfile",
    request: { id: chunk(R.other), newId: chunk(R.other, OTHER_PROFILE), profile: OTHER_PROFILE },
  });
  harness("indices_after_writer", "listIndices");

  embed("emb_thai", ALPHA, R.thai, E0);
  embed("emb_fox", ALPHA, R.fox, E1);
  embed("emb_mix", ALPHA, R.mix, MIX);
  embed("emb_retired", ALPHA, R.retired, E0);
  embed("emb_old", ALPHA, R.old, E0);
  embed("emb_successor", ALPHA, R.successor, E2);
  embed("emb_stale1", ALPHA, R.stale1, E0);
  embed("emb_beta", BETA, R.beta, E0);
  embed("emb_other", ALPHA, R.other, E0, OTHER_PROFILE);
  // N.pending stays pending: indexed, never embedded. N.failed keeps its
  // vector AT e0, but its status is then set to `failed`.
  embed("emb_failed", ALPHA, R.failed, E0);
  harness("fail_chunk", "markChunkFailed", { id: chunk(R.failed) });

  // Lifecycle AFTER indexing, so the ineligible nodes' chunks really exist.
  ops.push({
    label: "retire",
    facade: "context",
    method: "retireNode",
    request: { workspace_name: ALPHA, node_id: N.retired, expected_revision_id: R.retired, reason: "retired for the test", peer_name: null, operation_id: "op-retire" },
  });
  ops.push({
    label: "supersede",
    facade: "context",
    method: "supersedeNode",
    request: {
      workspace_name: ALPHA,
      node_id: N.old,
      expected_revision_id: R.old,
      new_node_id: N.successor,
      new_revision_id: R.successor,
      reason: "replaced for the test",
      peer_name: null,
      operation_id: "op-supersede",
    },
  });
  // A second revision whose head is NOT indexed: the first revision's chunk
  // still sits in search_chunks_v1, stale.
  publish("pub_stale2", ALPHA, alpha, N.stale, "stale note", "plain replacement", R.stale1);

  // ── keyword ─────────────────────────────────────────────────────────────
  keyword("kw_inside_word", "ลืม");
  keyword("kw_inside_word_again", "ลืม");
  keyword("kw_false_positive", "หลงทาง");
  keyword("kw_short", "ลื");
  keyword("kw_short_thai", "ไป");
  keyword("kw_stale", "zebrafish");
  keyword("kw_superseded", "superseded-marker");
  keyword("kw_successor", "successor-marker");
  keyword("kw_retired", "retired-marker");
  keyword("kw_other_workspace", "beta-marker");
  keyword("kw_beta", "ลืม", {}, BETA);
  keyword("kw_limit_one", "ลืม", { limit: 1 });
  keyword("kw_english_case", "QUICK Brown");
  keyword("kw_limit_over", "ลืม", { limit: 51 });
  keyword("kw_unknown_workspace", "ลืม", {}, "no-such-workspace");
  keyword("kw_other_profile_text", "other-profile-marker");
  // What the candidate query ITSELF returns, before any re-check.
  harness("spy_ngram", "spyKeyword", { workspace_name: ALPHA, query: "ลืม" });
  harness("spy_short", "spyKeyword", { workspace_name: ALPHA, query: "ลื" });

  // An index the writer did not build (dropped, then an older icu one): the
  // reader falls back to the scan and says why; only the writer repairs it.
  harness("drop", "dropIndices");
  keyword("kw_no_index", "ลืม");
  harness("spy_no_index", "spyKeyword", { workspace_name: ALPHA, query: "ลืม" });
  harness("indices_after_no_index_read", "listIndices");
  harness("icu", "createIcuIndex");
  keyword("kw_icu_index", "ลืม");
  index("idx_thai_replay", ALPHA, N.thai, R.thai);
  harness("indices_after_repair", "listIndices");
  index("idx_thai_replay_again", ALPHA, N.thai, R.thai);
  harness("indices_after_second_replay", "listIndices");
  keyword("kw_after_repair", "ลืม");

  // ── semantic ────────────────────────────────────────────────────────────
  semantic("sem_nearest", "q-e0");
  semantic("sem_limit_two", "q-e0", { limit: 2 });
  semantic("sem_explicit_profile", "q-e0", { embedding_profile: PROFILE });
  semantic("sem_profile_mismatch", "q-e0", { embedding_profile: OTHER_PROFILE });
  semantic("sem_embedder_down", "q-unknown");
  semantic("sem_beta", "q-e0", {}, BETA);
  ops.push({ label: "sem_other_default", facade: "reader_other", method: "searchKnowledgeSemantic", request: { workspace_name: ALPHA, query: "q-e0" } });
  harness("embed_calls", "embedCalls");
  return ops;
}

type Hit = {
  node_id: string;
  revision_id: string;
  title: string;
  snippet: string;
  chunk_ids: string[];
  match?: string;
  rank?: number;
  distance?: number;
};

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
const failed = (label: string) => {
  const result = out[label];
  expect(result?.ok, `${label}: ${JSON.stringify(result)}`).toBe(false);
  return result;
};
const nodes = (label: string) => (ok(label).hits as Hit[]).map((hit) => hit.node_id);

describe("#30 knowledge retrieval on a real gated dataset", () => {
  runIt(
    "setup: publish, index, embed and lifecycle all land",
    async () => {
      const fixture = await createFixture([ALPHA, BETA]);
      cleanups.push(fixture.cleanup);
      const result = await runGated(
        fixture.datasetRoot,
        CHILD,
        [
          fixture.datasetRoot,
          JSON.stringify({
            ops: buildOps(fixture),
            revisionIds: REVISIONS,
            embedderProfile: PROFILE,
            otherProfile: OTHER_PROFILE,
            queryVectors: { "q-e0": E0 },
          }),
        ],
        { deadlineMs: TIMEOUT_MS - 10_000 },
      );
      if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 2000)}`);
      out = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);
      for (const label of Object.keys(out).filter((l) => /^(pub|idx|emb)_/.test(l))) ok(label);
      expect(ok("retire").outcome).toBe("accepted");
      expect(ok("supersede").outcome).toBe("accepted");
      expect(ok("pub_stale2").revision_id).toBe(R.stale2);
      // The planted second-profile row: exactly one, under OTHER_PROFILE only.
      expect(ok("idx_other_relabel")).toEqual([{ id: chunk(R.other, OTHER_PROFILE), embedding_profile: OTHER_PROFILE }]);
      expect(out.readerContextMethods).toEqual(expect.arrayContaining(["searchKnowledgeKeyword", "searchKnowledgeSemantic"]));
      // Reader-only (#30 merged under #32 / R9's rule): no writer facade searches.
      expect(out.writerContextMethods).not.toContain("searchKnowledgeKeyword");
      expect(out.writerContextMethods).not.toContain("searchKnowledgeSemantic");
      expect(out.writerContextMethods).toContain("indexRevisionChunks");
    },
    TIMEOUT_MS,
  );

  runIt("keyword: Thai ลืม finds the node whose body holds หลงลืม, at its head revision (#10 inside-word case)", () => {
    const value = ok("kw_inside_word");
    expect(value.match).toBe("ngram");
    expect(value.scan_reason).toBeNull();
    // Only current, recall-eligible alpha nodes whose head contains ลืม.
    expect(nodes("kw_inside_word").sort()).toEqual([N.thai, N.pending].sort());
    const thai = (value.hits as Hit[]).find((hit) => hit.node_id === N.thai)!;
    expect(thai.revision_id).toBe(R.thai);
    expect(thai.title).toBe("บันทึก");
    expect(thai.snippet).toContain("หลงลืม");
    expect(thai.chunk_ids).toEqual([chunk(R.thai)]);
    expect(thai.match).toBe("ngram");
    // R21: an integer position, never the raw BM25 score.
    expect(typeof thai.rank).toBe("number");
  });

  runIt("keyword: หลงทาง shares the trigram หลง but is not contained anywhere -- no false positive", () => {
    const value = ok("kw_false_positive");
    expect(value.match).toBe("ngram");
    expect(value.hits).toEqual([]);
  });

  runIt("keyword: a query under 3 code points is the bounded substring scan, and says so", () => {
    const short = ok("kw_short");
    expect(short.match).toBe("substring_scan");
    expect(short.scan_reason).toBe("short_query");
    expect(nodes("kw_short")).toEqual([N.thai, N.pending].sort());
    // R21: every hit carries its 1-based position, never a null score.
    for (const [index, hit] of (short.hits as Hit[]).entries()) {
      expect(hit.match).toBe("substring_scan");
      expect(hit.rank).toBe(index + 1);
    }
    expect(ok("kw_short_thai").match).toBe("substring_scan");
    expect(nodes("kw_short_thai")).toEqual([N.mix]);
  });

  runIt("keyword: retired, superseded, stale-revision and other-workspace chunks never surface", () => {
    expect(ok("kw_retired").hits).toEqual([]);
    expect(ok("kw_superseded").hits).toEqual([]);
    expect(ok("kw_stale").hits).toEqual([]);
    expect(ok("kw_other_workspace").hits).toEqual([]);
    // The successor of a supersession is itself current and eligible.
    expect(nodes("kw_successor")).toEqual([N.successor]);
    // Beta sees only beta, even though alpha holds the same text.
    expect(nodes("kw_beta")).toEqual([N.beta]);
    expect((ok("kw_beta").hits as Hit[])[0]!.revision_id).toBe(R.beta);
    // Chunk text is the same under every profile: keyword search is profile-blind.
    expect(nodes("kw_other_profile_text")).toEqual([N.other]);
    for (const label of ["kw_inside_word", "kw_short"]) {
      for (const id of [N.retired, N.old, N.stale, N.beta]) expect(nodes(label)).not.toContain(id);
    }
  });

  runIt("keyword: ordering is stable, the limit is bounded, case folds, unknown workspace is refused", () => {
    expect(ok("kw_inside_word_again")).toEqual(ok("kw_inside_word"));
    expect(ok("kw_limit_one").hits).toHaveLength(1);
    expect(ok("kw_limit_one").hits[0].node_id).toBe(ok("kw_inside_word").hits[0].node_id);
    // R21: rank is this answer's own 1-based position -- the ordering
    // guarantee (score then node id) is stable but no longer observable as a
    // number, only as position. `rank == index + 1` alone is the shape the
    // code always produces, so it cannot fail on its own; the explicit
    // node-id order below is what actually pins BM25 order (a mutant that
    // reverses or drops score ordering changes THIS, not the rank shape).
    const hits = ok("kw_inside_word").hits as Hit[];
    expect(hits.map((hit) => hit.rank)).toEqual(hits.map((_, index) => index + 1));
    expect(hits.map((hit) => hit.node_id)).toEqual([N.thai, N.pending]);
    expect(nodes("kw_english_case")).toEqual([N.fox]);
    expect(failed("kw_limit_over")).toMatchObject({ code: "invalid_value", path: "/limit" });
    expect(failed("kw_unknown_workspace")).toMatchObject({ code: "invalid_reference", path: "/workspace_name" });
  });

  runIt("keyword: the candidate query itself is workspace-scoped, on the index and on both scans", () => {
    for (const label of ["spy_ngram", "spy_short", "spy_no_index"]) {
      const { value, candidates } = ok(label) as { value: { match: string; hits: Hit[] }; candidates: string[] };
      // beta holds the same Thai text; its chunk is never even a candidate.
      expect(candidates, label).toContain(N.thai);
      expect(candidates, label).not.toContain(N.beta);
      expect(value.hits.map((hit) => hit.node_id).sort(), label).toEqual([N.thai, N.pending].sort());
    }
    expect(ok("spy_ngram").value.match).toBe("ngram");
    expect(ok("spy_short").value.match).toBe("substring_scan");
    expect(ok("spy_no_index").value).toMatchObject({ match: "substring_scan", scan_reason: "index_unavailable" });
  });

  runIt("index: the reader never creates it; the writer builds the shared ngram(3,3) index and rebuilds only on mismatch", () => {
    expect(ok("indices_before")).toEqual([]);
    const before = ok("kw_before_index");
    expect(before).toMatchObject({ match: "substring_scan", scan_reason: "index_unavailable", hits: [] });
    expect(ok("indices_after_reader")).toEqual([]);

    const built = ok("indices_after_writer") as Record<string, unknown>[];
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({
      columns: ["text"],
      base_tokenizer: "ngram",
      min_ngram_length: 3,
      max_ngram_length: 3,
      stem: false,
      remove_stop_words: false,
    });

    // Dropped: the reader answers by scan (still correct), and builds nothing.
    const noIndex = ok("kw_no_index");
    expect(noIndex).toMatchObject({ match: "substring_scan", scan_reason: "index_unavailable" });
    expect(noIndex.hits.map((h: Hit) => h.node_id).sort()).toEqual([N.thai, N.pending].sort());
    expect(ok("indices_after_no_index_read")).toEqual([]);
    // An icu index is not the governed config: still a scan, not an icu miss.
    const icu = ok("kw_icu_index");
    expect(icu).toMatchObject({ match: "substring_scan", scan_reason: "index_unavailable" });
    expect(icu.hits.map((h: Hit) => h.node_id).sort()).toEqual([N.thai, N.pending].sort());

    // The writer's next index call repairs it under one name; a second call
    // with a matching index rebuilds nothing.
    const repaired = ok("indices_after_repair") as Record<string, unknown>[];
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({ base_tokenizer: "ngram", min_ngram_length: 3, max_ngram_length: 3 });
    expect(ok("indices_after_second_replay")).toEqual(repaired);
    expect(ok("kw_after_repair").match).toBe("ngram");
    // Same answer set; BM25 scores may move once every row is indexed.
    expect(nodes("kw_after_repair").sort()).toEqual(nodes("kw_inside_word").sort());
  });

  runIt("semantic: stub vectors rank nearest first by squared L2, over READY head chunks of eligible nodes only", () => {
    const value = ok("sem_nearest");
    expect(value.embedding_profile).toBe(PROFILE);
    expect(value.metric).toBe("l2_squared");
    const hits = value.hits as Hit[];
    // thai=e0 (0), mix=(e0+e1)/sqrt2 (2 - sqrt2), fox=e1 (2), successor=e2 (2):
    // a tie at 2 is broken by node id. retired/old/stale1/beta sit AT e0,
    // pending has no vector, `other` sits AT e0 under another profile, and
    // `failed` sits AT e0 with status `failed`: none of them may appear.
    expect(ok("fail_chunk")).toEqual([{ status: "failed", has_vector: true }]);
    expect(hits.map((hit) => hit.node_id)).toEqual([N.thai, N.mix, ...[N.fox, N.successor].sort()]);
    expect(hits[0]!.distance).toBeCloseTo(0, 5);
    expect(hits[1]!.distance).toBeCloseTo(2 - Math.SQRT2, 5);
    expect(hits[2]!.distance).toBeCloseTo(2, 5);
    expect(hits[0]!.revision_id).toBe(R.thai);
    expect(hits[0]!.chunk_ids).toEqual([chunk(R.thai)]);
    expect(hits[0]!.snippet).toContain("หลงลืม");
    expect(nodes("sem_limit_two")).toEqual([N.thai, N.mix]);
    expect(ok("sem_explicit_profile")).toEqual(value);
    expect(nodes("sem_beta")).toEqual([N.beta]);
  });

  runIt("semantic: the default profile is the query embedder's own, and its search reads only that profile's vectors", () => {
    const value = ok("sem_other_default");
    expect(value.embedding_profile).toBe(OTHER_PROFILE);
    expect(nodes("sem_other_default")).toEqual([N.other]);
    expect(value.hits[0].chunk_ids).toEqual([chunk(R.other, OTHER_PROFILE)]);
    expect(value.hits[0].distance).toBeCloseTo(0, 5);
    expect(nodes("sem_nearest")).not.toContain(N.other);
  });

  runIt("semantic: a profile the embedder does not serve is refused; an embedder failure is model_unavailable (R21)", () => {
    expect(failed("sem_profile_mismatch")).toMatchObject({ code: "invalid_value", path: "/embedding_profile" });
    expect(failed("sem_embedder_down")).toMatchObject({ code: "model_unavailable" });
    // The refused profile never reached the model; keyword search never does.
    const calls = ok("embed_calls") as string[];
    expect(calls.filter((q) => q === "q-e0")).toHaveLength(5);
    expect(calls).not.toContain("ลืม");
  });
});
