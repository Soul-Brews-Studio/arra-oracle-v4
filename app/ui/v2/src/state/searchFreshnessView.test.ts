/** Failing-first tests for the node view's search freshness (#33 design
 *  revision 2 "render freshness"; #30's `getSearchFreshness` had no UI
 *  consumer on d949290).
 *
 * `getSearchFreshness` answers for the WORKSPACE (content counts, text-index
 * rows, the active profile's pending/ready/failed vectors, model digests);
 * it has no node or revision parameter. So THIS node's state comes from its
 * head revision's own chunks under that active profile (`listSearchChunks`),
 * and the workspace figures are shown as workspace figures, never as the
 * node's. A read that failed, or answered in a shape this UI does not know,
 * is `unknown` -- never "indexed".
 */
import { describe, expect, test } from "bun:test";
import { type FreshnessRead, searchFreshnessView } from "./searchFreshnessView";

const PROFILE = "minilm-l6-v2/384";

function freshness(overrides: Record<string, unknown> = {}) {
  return {
    content: { nodes: 3, revisions: 5 },
    text_index: { indexed_rows: null, unindexed_rows: null },
    vectors: {
      profile_id: PROFILE,
      pending: 2,
      ready: 4,
      failed: 1,
      last_attempt_at: null,
      model_digest: { pinned: null, last_measured: null },
    },
    ...overrides,
  };
}

function chunk(status: string, error_code: string | null = null) {
  return { status, attempts: "0", error_code, embedding_profile: PROFILE, last_attempt_at: null };
}

const ok = (chunks: unknown[], f: unknown = freshness()): FreshnessRead => ({
  phase: "ok",
  freshness: f,
  chunks,
  eligibility: { ok: true, body: { eligible: true, witness_event_id: "0", reasons: [] } },
});

describe("searchFreshnessView: one state per node, honest about each", () => {
  test("no chunks under the active profile: unindexed", () => {
    const v = searchFreshnessView(ok([]));
    expect(v.state).toBe("unindexed");
    expect(v.label).toBe("unindexed");
    expect(v.meaning).toContain("neither keyword nor semantic search");
    expect(v.profile).toBe(PROFILE);
    expect(v.chunks).toEqual({ total: 0, pending: 0, ready: 0, failed: 0 });
  });

  test("chunked, vectors not written yet: pending, which is a queue state, not an error", () => {
    const v = searchFreshnessView(ok([chunk("pending"), chunk("ready")]));
    expect(v.state).toBe("pending");
    expect(v.label).toBe("pending — not embedded yet");
    expect(v.meaning).toContain("1 of 2 chunks");
    expect(v.meaning).toContain("semantic search");
    expect(v.meaning).not.toContain("failed");
  });

  test("any failed chunk: failed, with the stored error code, and the content is still saved", () => {
    const v = searchFreshnessView(ok([chunk("ready"), chunk("failed", "embedder_unavailable")]));
    expect(v.state).toBe("failed");
    expect(v.label).toBe("failed — embedding failed");
    expect(v.errorCodes).toEqual(["embedder_unavailable"]);
    expect(v.meaning).toContain("1 of 2 chunks");
    expect(v.meaning).toContain("content itself is saved");
  });

  test("every chunk ready: indexed", () => {
    const v = searchFreshnessView(ok([chunk("ready"), chunk("ready")]));
    expect(v.state).toBe("indexed");
    expect(v.label).toBe("indexed");
    expect(v.chunks).toEqual({ total: 2, pending: 0, ready: 2, failed: 0 });
  });

  test("a failed freshness read is unknown, never fresh", () => {
    const v = searchFreshnessView({ phase: "error", stage: "freshness", message: "HTTP 500" });
    expect(v.state).toBe("unknown");
    expect(v.label).toBe("unknown");
    expect(v.meaning).toContain("HTTP 500");
    expect(v.meaning).toContain("not a claim that it is fresh");
    expect(v.profile).toBeNull();
    expect(v.workspace).toBeNull();
  });

  test("a failed chunk read is unknown too, even though freshness itself answered", () => {
    const v = searchFreshnessView({ phase: "error", stage: "chunks", message: "limit_exceeded" });
    expect(v.state).toBe("unknown");
  });

  test("a malformed response is unknown, not a zero", () => {
    expect(searchFreshnessView(ok([], { content: {} })).state).toBe("unknown");
    expect(searchFreshnessView(ok([{ status: "embedded" }])).state).toBe("unknown");
    expect(searchFreshnessView(ok("nope" as unknown as unknown[])).state).toBe("unknown");
  });

  test("still loading is its own state, not indexed", () => {
    expect(searchFreshnessView({ phase: "loading" }).state).toBe("loading");
  });
});

describe("searchFreshnessView: workspace-wide figures stay labelled as such", () => {
  const rows = (f: unknown) =>
    Object.fromEntries(searchFreshnessView(ok([chunk("ready")], f)).workspace!.map((r) => [r.key, r.value]));

  test("vector counts and the embedding profile", () => {
    const w = rows(freshness());
    expect(w.profile).toBe(PROFILE);
    expect(w.vectors).toBe("4 ready · 2 pending · 1 failed");
  });

  test("a null text index is unknown, not zero indexed", () => {
    expect(rows(freshness()).text_index).toBe("unknown — no index yet, or shared with another workspace");
    expect(rows(freshness({ text_index: { indexed_rows: 7, unindexed_rows: 2 } })).text_index).toBe(
      "7 rows indexed · 2 not yet",
    );
  });

  test("never-attempted and unpinned are said as such", () => {
    const w = rows(freshness());
    expect(w.last_attempt).toBe("never attempted");
    expect(w.model_digest).toBe("not pinned yet · not measured by this server process");
  });
});
