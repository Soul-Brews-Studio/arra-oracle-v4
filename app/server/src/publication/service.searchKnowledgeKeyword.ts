import {
  containsFolded,
  FTS_MIN_QUERY_CODE_POINTS,
  likeContainsPredicate,
  overfetch,
  type FtsMatch,
} from "../fts/fts";
import { groupKnowledgeHits, parseSearchKnowledgeKeyword, rankedChunk } from "./search-chunk";
import { SEARCH_CHUNKS, SEARCH_HIT_COLUMNS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { currentEligibleChunks } from "./service.currentEligibleChunks";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/** Why a keyword answer came from the scan rather than the trigram index. */
export type ScanReason = "short_query" | "index_unavailable";

/**
 * #30 keyword retrieval over the target-19 knowledge tier (overnight R7 #30
 * part + R14): the nodes whose CURRENT, recall-eligible head revision
 * contains `query` as a case-folded substring.
 *
 * - `match: "ngram"`: the shared trigram index on `search_chunks_v1.text`
 *   (`FTS_INDEX_OPTIONS`, the same config as the legacy memories index) finds
 *   candidates in BM25 order; each is re-checked as a literal substring, which
 *   drops the trigram over-matches (หลงทาง vs หลงลืม). `score` is the node's
 *   best chunk score.
 * - `match: "substring_scan"`: a bounded, escaped ILIKE scan in node-id order,
 *   `score: null`, when the query is under 3 code points (`scan_reason:
 *   "short_query"`: a trigram index has nothing to look up and would answer []
 *   silently) or when the index is absent or not the governed one
 *   (`"index_unavailable"`). The reader never builds it -- the writer does, in
 *   `indexRevisionChunks`.
 *
 * Candidates are chunks; answers are NODES: every chunk must belong to its
 * node's captured head revision on a recall-eligible node
 * (`currentEligibleChunks`), and a node's chunks collapse into one hit. Both
 * candidate reads and every follow-up read are scoped to the workspace. The
 * overfetch bound is `fts/fts.overfetch.ts`'s. Keyword and semantic answers are
 * never fused (R7).
 */
export async function searchKnowledgeKeyword(reader: DatasetAdapter, requestBytes: Uint8Array) {
  const request = parseSearchKnowledgeKeyword(requestBytes);
  await requireWorkspace(reader, request.workspace_name);
  await reader.refresh(SEARCH_CHUNKS);
  const scope = contextScope(request.workspace_name);

  const short = [...request.query].length < FTS_MIN_QUERY_CODE_POINTS;
  const indexed = !short && (await reader.searchChunkTextIndexStatus()) === "ready";
  const match: FtsMatch = indexed ? "ngram" : "substring_scan";
  const scanReason: ScanReason | null = indexed ? null : short ? "short_query" : "index_unavailable";

  const current = currentEligibleChunks(reader, request.workspace_name);
  const hits = await overfetch(request.limit, async (fetch) => {
    const candidates = indexed
      ? await reader.fullTextSearchChunks(request.query, scope, fetch)
      : await reader.orderedProjection(
          SEARCH_CHUNKS,
          `(${scope}) AND ${likeContainsPredicate("text", request.query)}`,
          [...SEARCH_HIT_COLUMNS],
          { column: "node_id", ascending: true },
          fetch,
        );
    const verified = candidates
      .filter((row) => containsFolded(row.text, request.query))
      .map((row) => rankedChunk(row, indexed ? row._score : null));
    const kept = await current(verified);
    return { fetched: candidates.length, kept: groupKnowledgeHits(kept.chunks, kept.heads, "descending", request.query) };
  });

  return {
    match,
    scan_reason: scanReason,
    hits: hits.map((hit) => ({
      node_id: hit.node_id,
      revision_id: hit.revision_id,
      title: hit.title,
      snippet: hit.snippet,
      chunk_ids: hit.chunk_ids,
      score: hit.rank,
      match,
    })),
  };
}
