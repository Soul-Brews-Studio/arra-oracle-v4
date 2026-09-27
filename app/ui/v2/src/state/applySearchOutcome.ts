import type { ApiResult } from "../api/client";
import { describeResult } from "./describeResult";
import type { KeywordHitWire, SemanticHitWire } from "./searchHitView";
import type { SearchMode } from "./useKnowledgeSearch";

export type SearchOutcome = {
  /** Which mode's response this outcome IS -- not the search box's current
   *  toggle value. `searchOutcomeView` compares this against the active
   *  mode to decide whether `scanReason` still describes what is on screen
   *  (fix-round finding, PR #110 follow-up #1: the 300ms debounce means a
   *  mode switch and the outcome that answers it never land atomically). */
  mode: SearchMode;
  errorCode: string | null;
  keywordHits: KeywordHitWire[];
  semanticHits: SemanticHitWire[];
  scanReason: "short_query" | "index_unavailable" | null;
  embeddingProfile: string | null;
  /** #30: the response said `coverage: "partial"` -- its candidate read hit
   *  the server's bound, so results may be incomplete. Both modes set it. */
  coveragePartial: boolean;
};

/** Turns one `searchKnowledgeKeyword` / `searchKnowledgeSemantic` response
 *  into the next search state -- extracted out of `useKnowledgeSearch`'s
 *  inline branches so this transition is a plain, DOM-free unit.
 *
 * `keywordHits`/`semanticHits` are kept separate on purpose (switching mode
 * should not blank out the other mode's last answer mid-debounce), but
 * `scanReason` is NOT mode-scoped state: it describes how the CURRENT
 * response was produced, and only `searchKnowledgeKeyword` ever sets it.
 * A semantic response must always clear it. `mode` records which response
 * this is, so `searchOutcomeView` can tell "the last reply we got" from
 * "the mode the user has selected right now" -- see that file's comment.
 */
export function applySearchOutcome(mode: SearchMode, result: ApiResult, previous: SearchOutcome): SearchOutcome {
  if (!result.ok) {
    return { ...previous, mode, errorCode: describeResult(result), keywordHits: [], semanticHits: [], scanReason: null, coveragePartial: false };
  }
  if (mode === "keyword") {
    const body = result.body as { hits?: KeywordHitWire[]; scan_reason?: "short_query" | "index_unavailable" | null; coverage?: string };
    return {
      ...previous,
      mode,
      errorCode: null,
      keywordHits: Array.isArray(body.hits) ? body.hits : [],
      scanReason: body.scan_reason ?? null,
      coveragePartial: body.coverage === "partial",
    };
  }
  const body = result.body as { hits?: SemanticHitWire[]; embedding_profile?: string; coverage?: string };
  return {
    ...previous,
    mode,
    errorCode: null,
    semanticHits: Array.isArray(body.hits) ? body.hits : [],
    // Fix (blocking, fix round 2026-09-26): semantic responses never carry
    // `scan_reason` -- clear whatever a KEYWORD search left behind, or its
    // note ("used a plain substring scan…") renders on real semantic hits.
    scanReason: null,
    embeddingProfile: body.embedding_profile ?? null,
    coveragePartial: body.coverage === "partial",
  };
}
