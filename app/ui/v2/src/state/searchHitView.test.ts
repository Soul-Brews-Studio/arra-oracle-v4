/** Failing-first tests for `searchHitView` (#33 search box: rank vs
 *  distance, per-hit match mode). Pure, no DOM: `bun test src/state/searchHitView.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { searchHitView, type KeywordHitWire, type SemanticHitWire } from "./searchHitView";

const keywordHit: KeywordHitWire = {
  node_id: "n1",
  revision_id: "r1",
  title: "Do not forget the snapshot",
  snippet: "…อย่าหลงลืม snapshot…",
  chunk_ids: ["c1"],
  rank: 3,
  match: "ngram",
};

const semanticHit: SemanticHitWire = {
  node_id: "n2",
  revision_id: "r2",
  title: "Migration notes",
  snippet: "…rehearsal before migrating…",
  chunk_ids: ["c2"],
  distance: 0.123456,
};

describe("searchHitView", () => {
  test("keyword hit shows rank (R21: no raw score) and its match mode", () => {
    const view = searchHitView(keywordHit, "keyword");
    expect(view.rankLabel).toBe("#3");
    expect(view.matchLabel).toBe("ngram");
    expect(view.title).toBe(keywordHit.title);
    expect(view.snippet).toBe(keywordHit.snippet);
    expect(view.node_id).toBe("n1");
  });

  test("keyword hit found only by the seam/substring scan carries that mode", () => {
    const view = searchHitView({ ...keywordHit, match: "substring_scan" }, "keyword");
    expect(view.matchLabel).toBe("substring_scan");
  });

  test("semantic hit shows a raw distance and no match label", () => {
    const view = searchHitView(semanticHit, "semantic");
    expect(view.rankLabel).toBe("distance 0.1235");
    expect(view.matchLabel).toBeNull();
    expect(view.node_id).toBe("n2");
  });

  test("key is stable per node+revision so React keys never collide across a re-fetch", () => {
    const a = searchHitView(keywordHit, "keyword");
    const b = searchHitView(keywordHit, "keyword");
    expect(a.key).toBe(b.key);
    expect(a.key).toBe("n1:r1");
  });
});
