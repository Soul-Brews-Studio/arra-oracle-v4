import type { SearchOutcome } from "./applySearchOutcome";
import type { KeywordHitWire, SemanticHitWire } from "./searchHitView";
import type { SearchMode } from "./useKnowledgeSearch";

export type SearchOutcomeView = {
  hits: (KeywordHitWire | SemanticHitWire)[];
  errorCode: string | null;
  scanReason: "short_query" | "index_unavailable" | null;
  embeddingProfile: string | null;
};

/** Decides what `useKnowledgeSearch` hands the results panel for the
 *  CURRENTLY ACTIVE mode, out of the last `SearchOutcome` -- extracted from
 *  the hook's return statement so this decision is a plain, DOM-free unit.
 *
 * Fix-round finding #1 (PR #110 follow-up): switching Keyword -> Semantic
 * only fires a new request after the 300ms debounce in `useKnowledgeSearch`.
 * Until that reply lands, `outcome` is still the LAST response, which was
 * keyword and carries a `scanReason`. The active `mode` is already
 * "semantic", so showing `outcome.scanReason` during that window redisplays
 * a note ("used a plain substring scan…") that describes a search that is no
 * longer running. Gating on `outcome.mode === mode` -- the mode that
 * actually PRODUCED this outcome, not just the toggle's current value --
 * closes the window entirely: the note disappears the instant the toggle
 * changes, not ~300ms later when the semantic reply (which never carries a
 * scanReason anyway) arrives.
 *
 * `errorCode` is gated the same way (round-3 non-blocking finding): a
 * failure recorded for the mode that was active when the reply landed must
 * not keep rendering through the same debounce window after the toggle has
 * already moved on to the other mode -- e.g. Semantic fails with
 * `model_unavailable`, the user flips to Keyword, and for one debounce
 * window Keyword must not show a banner that says it needs a model it does
 * not.
 */
export function searchOutcomeView(outcome: SearchOutcome, mode: SearchMode): SearchOutcomeView {
  return {
    hits: mode === "keyword" ? outcome.keywordHits : outcome.semanticHits,
    errorCode: outcome.mode === mode ? outcome.errorCode : null,
    scanReason: outcome.mode === mode ? outcome.scanReason : null,
    embeddingProfile: outcome.embeddingProfile,
  };
}
