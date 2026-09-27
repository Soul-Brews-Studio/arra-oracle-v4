/** Failing-first (fix round, 2026-09-26): PR #110 follow-up #1. An
 *  independent verifier found that after switching Keyword -> Semantic, the
 *  keyword scan note stays on screen for ~300ms (the debounce window)
 *  because `state.scanReason` was read from `outcome` with no check on
 *  which mode actually produced it. `bun test src/state/searchOutcomeView.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { SearchOutcome } from "./applySearchOutcome";
import { searchOutcomeView } from "./searchOutcomeView";

const keywordHit = {
  node_id: "n1",
  revision_id: "r1",
  title: "t",
  snippet: "s",
  chunk_ids: [],
  rank: 1,
  match: "ngram" as const,
};

const outcomeAfterKeyword: SearchOutcome = {
  mode: "keyword",
  errorCode: null,
  keywordHits: [keywordHit],
  semanticHits: [],
  scanReason: "short_query",
  embeddingProfile: null,
};

describe("searchOutcomeView", () => {
  test("a keyword outcome viewed while still in keyword mode shows its own scan note", () => {
    const view = searchOutcomeView(outcomeAfterKeyword, "keyword");
    expect(view.scanReason).toBe("short_query");
    expect(view.hits).toEqual([keywordHit]);
  });

  test("switching to semantic before the debounced reply lands hides the stale keyword note immediately", () => {
    // The user just clicked "Semantic". `outcome` is still the last KEYWORD
    // response -- useKnowledgeSearch's 300ms debounce has not fired the
    // semantic request yet -- but the active toggle is already "semantic".
    const view = searchOutcomeView(outcomeAfterKeyword, "semantic");
    expect(view.scanReason).toBeNull();
    // And it must show semantic's own (empty, so far) hits, not the stale
    // keyword ones -- switching modes must not bleed the other mode's list.
    expect(view.hits).toEqual([]);
  });

  test("a semantic outcome never carries a scan note even when viewed in semantic mode", () => {
    const outcomeAfterSemantic: SearchOutcome = {
      mode: "semantic",
      errorCode: null,
      keywordHits: [],
      semanticHits: [],
      scanReason: null,
      embeddingProfile: "e5",
    };
    const view = searchOutcomeView(outcomeAfterSemantic, "semantic");
    expect(view.scanReason).toBeNull();
    expect(view.embeddingProfile).toBe("e5");
  });
});
