/** `searchKnowledgeKeyword` / `searchKnowledgeSemantic` -- #30/#33, never
 *  called from this UI before this file (`docs/SCHEMA-BUILT.md`'s name scan).
 *  Same thin `callMethod` wrapper every other `api/*.ts` file uses; the
 *  interesting parts are the wire shapes, verified against
 *  `service.searchKnowledgeKeyword.ts` / `service.searchKnowledgeSemantic.ts`
 *  and their parsers, not guessed:
 *
 *   - keyword: `{workspace_name, query, limit?}` -> `{match, scan_reason,
 *     hits: [{..., rank, match}]}`. No raw score ever crosses the wire (R21).
 *   - semantic: `{workspace_name, query, limit?, embedding_profile?}` ->
 *     `{embedding_profile, metric, hits: [{..., distance}]}`. Passing
 *     `embedding_profile` to KEYWORD search is `unexpected_field` -- the two
 *     request shapes are not interchangeable, so they get distinct types.
 */
import { type KeywordHitWire, type SemanticHitWire } from "../state/searchHitView";

/** #30 coverage (`search-chunk-v1.md` section 21): whether the answer's
 *  candidate read reached the server's bound, on both methods. */
export type SearchCoverage = {
  coverage: "full" | "partial";
  coverage_reason: "candidate_ceiling" | null;
  candidate_ceiling: number;
};

export type KeywordSearchResult = SearchCoverage & {
  match: "ngram" | "substring_scan";
  scan_reason: "short_query" | "index_unavailable" | null;
  hits: KeywordHitWire[];
};

export type SemanticSearchResult = SearchCoverage & {
  embedding_profile: string;
  metric: "l2_squared";
  hits: SemanticHitWire[];
};

// searchKnowledgeKeyword / searchKnowledgeSemantic moved out (style-ui-split,
// docs/overnight/DECISIONS.md): each lives in its own file named after
// itself. Re-exported here so importers (`state/useKnowledgeSearch.ts`) do
// not churn.
export { searchKnowledgeKeyword } from "./search.searchKnowledgeKeyword";
export { searchKnowledgeSemantic } from "./search.searchKnowledgeSemantic";
