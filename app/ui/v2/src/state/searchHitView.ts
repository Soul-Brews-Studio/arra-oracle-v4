/** Pure mapping from one wire hit (`searchKnowledgeKeyword` /
 *  `searchKnowledgeSemantic`) to what a row renders.
 *
 * The two methods answer different hit shapes (overnight R21/R22,
 * `service.searchKnowledgeKeyword.ts` / `service.searchKnowledgeSemantic.ts`):
 *   - keyword: `rank` (1-based position, no raw score) + `match`
 *     (`"ngram" | "substring_scan"`), per hit.
 *   - semantic: `distance` (raw L2-squared, never a corpus statistic), no
 *     per-hit match field -- the profile is on the RESPONSE, not the hit.
 * This file is the one place that knows which fields belong to which mode,
 * so a component never has to guess which optional field is meaningful.
 */
export type KeywordHitWire = {
  node_id: string;
  revision_id: string;
  title: string;
  snippet: string;
  chunk_ids: string[];
  rank: number;
  match: "ngram" | "substring_scan";
};

export type SemanticHitWire = {
  node_id: string;
  revision_id: string;
  title: string;
  snippet: string;
  chunk_ids: string[];
  distance: number;
};

export type SearchHitView = {
  key: string;
  node_id: string;
  title: string;
  snippet: string;
  /** "#3" for keyword (its 1-based rank, R21: never the raw score), or
   *  "distance 0.1234" for semantic (its raw per-row L2-squared distance). */
  rankLabel: string;
  /** The per-hit match mode for keyword ("ngram" | "substring_scan"); null
   *  for semantic, which has no such field. */
  matchLabel: "ngram" | "substring_scan" | null;
};

export function searchHitView(
  hit: KeywordHitWire | SemanticHitWire,
  mode: "keyword" | "semantic",
): SearchHitView {
  const base = {
    key: `${hit.node_id}:${hit.revision_id}`,
    node_id: hit.node_id,
    title: hit.title,
    snippet: hit.snippet,
  };
  if (mode === "keyword") {
    const h = hit as KeywordHitWire;
    return { ...base, rankLabel: `#${h.rank}`, matchLabel: h.match };
  }
  const h = hit as SemanticHitWire;
  return { ...base, rankLabel: `distance ${h.distance.toFixed(4)}`, matchLabel: null };
}
