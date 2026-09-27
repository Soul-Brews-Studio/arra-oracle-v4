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
import { type ApiResult, callMethod } from "./client";
import { type Bank } from "./memory";
import { type KeywordHitWire, type SemanticHitWire } from "../state/searchHitView";

export type KeywordSearchResult = {
  match: "ngram" | "substring_scan";
  scan_reason: "short_query" | "index_unavailable" | null;
  hits: KeywordHitWire[];
};

export type SemanticSearchResult = {
  embedding_profile: string;
  metric: "l2_squared";
  hits: SemanticHitWire[];
};

export const searchKnowledgeKeyword = (b: Bank, query: string, limit = 20): Promise<ApiResult> =>
  callMethod(b.bank, "searchKnowledgeKeyword", { workspace_name: b.workspace, query, limit }, b.token);

export const searchKnowledgeSemantic = (b: Bank, query: string, limit = 20): Promise<ApiResult> =>
  callMethod(b.bank, "searchKnowledgeSemantic", { workspace_name: b.workspace, query, limit }, b.token);
