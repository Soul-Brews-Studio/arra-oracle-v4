import type { RecallRow } from "./search.recall";

/** v3 cut a result's content at 500 characters (arra-oracle-v3 src/tools/search/fts.ts:49). */
const CONTENT_CODE_POINTS = 500;

/**
 * One v3 search result (test/fixtures/v3-compat-v1/shapes/oracle_search.json
 * `result`) from a recalled node. `id` is the v4 node id (A3); `content` is
 * the head body's first 500 code points, as v3 cut it (code points, so Thai
 * and emoji are never split); `source_file` is null, since v4 writes no file
 * (the caller names it in compat_warnings); `score` is `1/(1+position)` in
 * the answer's final order -- ORDER, never a kernel score value, which is
 * not v3's fused relevance. The v4 facts ride along under `v4`.
 */
export function v3Result(row: RecallRow, position: number, source: "fts" | "vector"): Record<string, unknown> {
  const { hit, facts } = row;
  return {
    id: hit.node_id,
    type: facts.v3Type,
    content: [...facts.body].slice(0, CONTENT_CODE_POINTS).join(""),
    source_file: null,
    concepts: facts.concepts,
    score: 1 / (1 + position),
    source,
    v4: {
      node_id: hit.node_id,
      revision_id: hit.revision_id,
      title: hit.title,
      snippet: hit.snippet,
      ...(hit.match === undefined ? {} : { match: hit.match }),
      ...(hit.matched_terms === undefined ? {} : { matched_terms: hit.matched_terms }),
      ...(hit.distance === undefined ? {} : { distance: hit.distance }),
    },
  };
}
