import { FTS_MIN_QUERY_CODE_POINTS, overfetch, type FtsMatch } from "../fts/fts";
import { failPublication } from "./errors";
import {
  chunkMayHoldQuery,
  groupKnowledgeHits,
  keywordHitOrder,
  keywordScanPredicate,
  parseSearchKnowledgeKeyword,
  rankedChunk,
  seamPredicate,
  type KeywordOrderKey,
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

/** One keyword hit before it goes on the wire: how it was found, and the R22
 *  key it is ordered by (neither key is on the wire; `rank` is its position). */
type OrderedHit = KnowledgeHit & KeywordOrderKey & { found: FtsMatch };

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
 *   candidate chunks, BM25's best first -- any chunk sharing a trigram with
 *   the query, so a chunk holding part of an occurrence cut by a chunk
 *   boundary is a candidate too. Each node is re-checked against its WHOLE
 *   head text, never against one chunk, which drops the trigram over-matches
 *   (หลงทาง vs หลงลืม) and keeps occurrences that straddle a boundary or
 *   outrun a chunk.
 *   A query of 3-4 code points can be cut so that no chunk holds a trigram of
 *   it; when the index answers fewer than `limit`, a seam scan
 *   (`seamPredicate`) adds those nodes, each marked `match:
 *   "substring_scan"`, and the whole answer is ordered together.
 * - `match: "substring_scan"`: a bounded, escaped ILIKE scan in node-id order
 *   (`keywordScanPredicate`, which crosses chunk seams too), when the query
 *   is under 3 code points (`scan_reason: "short_query"`: a trigram index has
 *   nothing to look up and would answer [] silently) or when the index is
 *   absent or not the governed one (`"index_unavailable"`). The reader never
 *   builds it -- the writer does, in `indexRevisionChunks`.
 *
 * ORDER (overnight R22, docs/overnight/DECISIONS.md): `search_chunks_v1` has
 * ONE FTS index shared by every workspace, and BM25's IDF and average document
 * length are computed over all of it. So BM25 only SELECTS candidates -- the
 * workspace-prefiltered, overfetched rounds above -- and never orders them.
 * Every path (index, seam, scan) orders its hits by `keywordHitOrder`, from
 * the node's own current head: occurrences of the query in its text
 * (`countFolded`, R14's case-folded rule), descending; then the head's
 * acceptance instant (`node_revisions.created_at`), descending; then node id.
 * `hits[].rank` (R21) is the 1-based position in that order and no raw score
 * is ever on the wire (R21 measured one moving 5.65 -> 2.38; R22 the ORDER
 * moving A3,A1,A2 -> A3,A2,A1, both on another workspace's writes alone).
 *
 * The bound, stated rather than hidden: a round reads at most `fetch`
 * candidates (`fts/fts.overfetch.ts`; the first is `limit *
 * FTS_CANDIDATE_FACTOR`), in BM25 order on the index path and node-id order on
 * the scans. When the workspace holds no more candidate chunks than the round
 * that ends the loop reads -- always, when it holds at most `limit *
 * FTS_CANDIDATE_FACTOR` -- the answer is a function of this workspace's rows
 * alone. Past that, WHICH candidates the index path reads is BM25's corpus-wide
 * pick, and another workspace's writes can change it (measured and pinned by
 * `search-chunk-retrieval-overfetch-bound.test.ts`): the answer is then the
 * best of those, in this order, still only this workspace's nodes. A
 * per-workspace index closes that. Semantic search's `distance` has no such
 * leak (verified in the `search-chunk-v1.md` R21 amendment: it is the L2
 * distance between the query vector and one stored row's own vector, never a
 * corpus-wide statistic) and keeps its raw number and order.
 *
 * Candidates are chunks; answers are NODES: `chunkMayHoldQuery` first drops,
 * without a read, every chunk no occurrence can touch; each surviving chunk
 * must then belong to its node's captured head revision, whose text holds the
 * query, on a recall-eligible node (`currentEligibleChunks`), and a node's
 * chunks collapse into one hit. The candidate reads and every follow-up read
 * are scoped to the workspace. The overfetch bound is `fts/fts.overfetch.ts`'s.
 * Keyword and semantic answers are never fused (R7).
 */
export async function searchKnowledgeKeyword(reader: DatasetAdapter, requestBytes: Uint8Array, requestTimeMs?: number) {
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

  const current = currentEligibleChunks(reader, request.workspace_name, query, requestTimeMs);
  /**
   * One overfetch round: candidates -> pre-filter -> current, matching,
   * eligible -> hits in R22 order, so the loop's `slice(0, limit)` keeps the
   * head of THAT order. No candidate keeps a source rank: the index's BM25
   * `_score` is never read.
   */
  const answer = async (rows: Record<string, unknown>[], found: FtsMatch, skip: ReadonlySet<string>) => {
    const candidates: RankedChunk[] = rows.map((row) => rankedChunk(row, null)).filter((chunk) => chunkMayHoldQuery(chunk.text, chunk.chunk_index, query));
    const kept = await current(candidates);
    const hits: OrderedHit[] = groupKnowledgeHits(kept.chunks, kept.heads, "descending", query)
      .filter((hit) => !skip.has(hit.node_id))
      .map((hit) => {
        const { occurrences, accepted_at } = kept.heads.get(hit.node_id)!;
        // A keyword head always carries both keys; one without them is a bug, never a guess.
        if (occurrences === undefined || accepted_at === undefined) failPublication("integrity_failure", "");
        return { ...hit, occurrences, accepted_at, found };
      })
      .sort(keywordHitOrder);
    return { fetched: rows.length, kept: hits };
  };
  /** Chunks matching `predicate` in node-id order: the unranked scans. */
  const scan = (predicate: string) => (fetch: number) =>
    reader.orderedProjection(SEARCH_CHUNKS, `(${scope}) AND ${predicate}`, [...SEARCH_HIT_COLUMNS], { column: "node_id", ascending: true }, fetch);

  let hits: OrderedHit[];
  if (indexed) {
    hits = await overfetch(limit, async (fetch) => answer(await reader.fullTextSearchChunks(query, scope, fetch), "ngram", new Set()));
    const seam = seamPredicate(query);
    if (hits.length < limit && codePoints <= SEAM_ONLY_MAX_CODE_POINTS && seam !== null) {
      const seen = new Set(hits.map((hit) => hit.node_id));
      const fetchSeam = scan(seam);
      const seamHits = await overfetch(limit - hits.length, async (fetch) => answer(await fetchSeam(fetch), "substring_scan", seen));
      // One answer, one order: a seam hit is ordered with the index hits, not after them.
      hits = [...hits, ...seamHits].sort(keywordHitOrder);
    }
  } else {
    const fetchScan = scan(keywordScanPredicate(query));
    hits = await overfetch(limit, async (fetch) => answer(await fetchScan(fetch), "substring_scan", new Set()));
  }

  return {
    match,
    scan_reason: scanReason,
    hits: hits.map((hit, index) => ({
      node_id: hit.node_id,
      revision_id: hit.revision_id,
      title: hit.title,
      snippet: hit.snippet,
      chunk_ids: hit.chunk_ids,
      // R21 + R22: the hit's 1-based position in this answer's workspace-local
      // order, never a raw BM25 score (the order keys stay off the wire too).
      rank: index + 1,
      // How THIS hit was found: an index hit, or a scan (the whole answer's
      // scan, or the seam scan of an index answer).
      match: hit.found,
    })),
  };
}
