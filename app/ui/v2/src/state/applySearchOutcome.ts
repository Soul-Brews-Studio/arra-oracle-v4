import type { ApiResult } from "../api/client";
import { describeResult } from "./describeResult";
import type { KeywordHitWire, SemanticHitWire } from "./searchHitView";
import type { SearchMode } from "./useKnowledgeSearch";

export type SearchOutcome = {
  errorCode: string | null;
  keywordHits: KeywordHitWire[];
  semanticHits: SemanticHitWire[];
  scanReason: "short_query" | "index_unavailable" | null;
  embeddingProfile: string | null;
};

/** Turns one `searchKnowledgeKeyword` / `searchKnowledgeSemantic` response
 *  into the next search state -- extracted out of `useKnowledgeSearch`'s
 *  inline branches so this transition is a plain, DOM-free unit.
 *
 * `keywordHits`/`semanticHits` are kept separate on purpose (switching mode
 * should not blank out the other mode's last answer mid-debounce), but
 * `scanReason` is NOT mode-scoped state: it describes how the CURRENT
 * response was produced, and only `searchKnowledgeKeyword` ever sets it.
 * A semantic response must always clear it.
 */
export function applySearchOutcome(mode: SearchMode, result: ApiResult, previous: SearchOutcome): SearchOutcome {
  if (!result.ok) {
    return { ...previous, errorCode: describeResult(result), keywordHits: [], semanticHits: [], scanReason: null };
  }
  if (mode === "keyword") {
    const body = result.body as { hits?: KeywordHitWire[]; scan_reason?: "short_query" | "index_unavailable" | null };
    return {
      ...previous,
      errorCode: null,
      keywordHits: Array.isArray(body.hits) ? body.hits : [],
      scanReason: body.scan_reason ?? null,
    };
  }
  const body = result.body as { hits?: SemanticHitWire[]; embedding_profile?: string };
  return {
    ...previous,
    errorCode: null,
    semanticHits: Array.isArray(body.hits) ? body.hits : [],
    // Fix (blocking, fix round 2026-09-26): semantic responses never carry
    // `scan_reason` -- clear whatever a KEYWORD search left behind, or its
    // note ("used a plain substring scan…") renders on real semantic hits.
    scanReason: null,
    embeddingProfile: body.embedding_profile ?? null,
  };
}
