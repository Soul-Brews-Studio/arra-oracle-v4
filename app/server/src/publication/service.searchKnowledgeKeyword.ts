import { FTS_MIN_QUERY_CODE_POINTS, overfetch, type FtsMatch } from "../fts/fts";
import {
  chunkMayHoldQuery,
  groupKnowledgeHits,
  keywordScanPredicate,
  parseSearchKnowledgeKeyword,
  rankedChunk,
  seamPredicate,
  type KnowledgeHit,
  type RankedChunk,
} from "./search-chunk";
import { SEARCH_CHUNKS, SEARCH_HIT_COLUMNS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { currentEligibleChunks } from "./service.currentEligibleChunks";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/** Why a keyword answer came from the scan rather than the trigram index. */
export type ScanReason = "short_query" | "index_unavailable";

/**
 * Up to this many code points, an occurrence can be cut by a chunk boundary
 * so that NEITHER chunk holds a whole trigram of it (หลง as หล|ง, wxyz as
 * wx|yz): the index cannot see it, and the seam scan must. From 5 code points
 * on, one side of any single cut keeps 3.
 */
const SEAM_ONLY_MAX_CODE_POINTS = 2 * (FTS_MIN_QUERY_CODE_POINTS - 1);

/**
 * #30 keyword retrieval over the target-19 knowledge tier (overnight R7 #30
 * part + R14): the nodes whose CURRENT, recall-eligible head revision text
 * (`title`, blank line, `body` -- what its chunks were cut from) contains
 * `query` as a case-folded substring.
 *
 * - `match: "ngram"`: the shared trigram index on `search_chunks_v1.text`
 *   (`FTS_INDEX_OPTIONS`, the same config as the legacy memories index) finds
 *   candidate chunks in BM25 order -- any chunk sharing a trigram with the
 *   query, so a chunk holding part of an occurrence cut by a chunk boundary
 *   is a candidate too. Each node is re-checked against its WHOLE head text,
 *   never against one chunk, which drops the trigram over-matches (หลงทาง vs
 *   หลงลืม) and keeps occurrences that straddle a boundary or outrun a chunk.
 *   `score` is the node's best chunk score. A query of 3-4 code points can be
 *   cut so that no chunk holds a trigram of it; when the index answers fewer
 *   than `limit`, a seam scan (`seamPredicate`) adds those nodes after every
 *   scored one, each marked `match: "substring_scan"`, `score: null`.
 * - `match: "substring_scan"`: a bounded, escaped ILIKE scan in node-id order
 *   (`keywordScanPredicate`, which crosses chunk seams too), `score: null`,
 *   when the query is under 3 code points (`scan_reason: "short_query"`: a
 *   trigram index has nothing to look up and would answer [] silently) or
 *   when the index is absent or not the governed one (`"index_unavailable"`).
 *   The reader never builds it -- the writer does, in `indexRevisionChunks`.
 *
 * Candidates are chunks; answers are NODES: `chunkMayHoldQuery` first drops,
 * without a read, every chunk no occurrence can touch; each surviving chunk
 * must then belong to its node's captured head revision, whose text holds the
 * query, on a recall-eligible node (`currentEligibleChunks`), and a node's
 * chunks collapse into one hit. The candidate reads and every follow-up read
 * are scoped to the workspace. The overfetch bound is `fts/fts.overfetch.ts`'s.
 * Keyword and semantic answers are never fused (R7).
 */
export async function searchKnowledgeKeyword(reader: DatasetAdapter, requestBytes: Uint8Array) {
  const request = parseSearchKnowledgeKeyword(requestBytes);
  const { query, limit } = request;
  await requireWorkspace(reader, request.workspace_name);
  await reader.refresh(SEARCH_CHUNKS);
  const scope = contextScope(request.workspace_name);

  const codePoints = [...query].length;
  const short = codePoints < FTS_MIN_QUERY_CODE_POINTS;
  const indexed = !short && (await reader.searchChunkTextIndexStatus()) === "ready";
  const match: FtsMatch = indexed ? "ngram" : "substring_scan";
  const scanReason: ScanReason | null = indexed ? null : short ? "short_query" : "index_unavailable";

  const current = currentEligibleChunks(reader, request.workspace_name, query);
  /** One overfetch round: candidates -> pre-filter -> current, matching, eligible -> hits. */
  const answer = async (rows: Record<string, unknown>[], rank: (row: Record<string, unknown>) => unknown, skip: ReadonlySet<string>) => {
    const candidates: RankedChunk[] = rows.map((row) => rankedChunk(row, rank(row))).filter((chunk) => chunkMayHoldQuery(chunk.text, chunk.chunk_index, query));
    const kept = await current(candidates);
    const hits = groupKnowledgeHits(kept.chunks, kept.heads, "descending", query).filter((hit) => !skip.has(hit.node_id));
    return { fetched: rows.length, kept: hits };
  };
  /** Chunks matching `predicate` in node-id order: the unranked scans. */
  const scan = (predicate: string) => (fetch: number) =>
    reader.orderedProjection(SEARCH_CHUNKS, `(${scope}) AND ${predicate}`, [...SEARCH_HIT_COLUMNS], { column: "node_id", ascending: true }, fetch);

  let hits: KnowledgeHit[];
  if (indexed) {
    hits = await overfetch(limit, async (fetch) => answer(await reader.fullTextSearchChunks(query, scope, fetch), (row) => row._score, new Set()));
    const seam = seamPredicate(query);
    if (hits.length < limit && codePoints <= SEAM_ONLY_MAX_CODE_POINTS && seam !== null) {
      const found = new Set(hits.map((hit) => hit.node_id));
      const fetchSeam = scan(seam);
      hits = [...hits, ...(await overfetch(limit - hits.length, async (fetch) => answer(await fetchSeam(fetch), () => null, found)))];
    }
  } else {
    const fetchScan = scan(keywordScanPredicate(query));
    hits = await overfetch(limit, async (fetch) => answer(await fetchScan(fetch), () => null, new Set()));
  }

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
      // How THIS hit was found: a ranked index hit, or a scan (the whole
      // answer's scan, or the seam scan of an index answer).
      match: (hit.rank === null ? "substring_scan" : "ngram") as FtsMatch,
    })),
  };
}
