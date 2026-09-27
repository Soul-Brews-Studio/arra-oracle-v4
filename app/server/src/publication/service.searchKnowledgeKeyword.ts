import { FTS_CANDIDATE_CEILING, FTS_MIN_QUERY_CODE_POINTS, type FtsMatch } from "../fts/fts";
import { failPublication } from "./errors";
import {
  chunkMayHoldQuery,
  coverageSignal,
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
 *   candidate chunks -- any chunk sharing a trigram with the query, so a
 *   chunk holding part of an occurrence cut by a chunk boundary is a
 *   candidate too. Each node is re-checked against its WHOLE head text, never
 *   against one chunk, which drops the trigram over-matches (หลงทาง vs
 *   หลงลืม) and keeps occurrences that straddle a boundary or outrun a chunk.
 *   A query of 3-4 code points can be cut so that no chunk holds a trigram of
 *   it; for such a query a seam scan (`seamPredicate`) also runs, always, and
 *   the nodes only it finds are marked `match: "substring_scan"`.
 * - `match: "substring_scan"`: an escaped ILIKE scan in node-id order
 *   (`keywordScanPredicate`, which crosses chunk seams too), when the query
 *   is under 3 code points (`scan_reason: "short_query"`: a trigram index has
 *   nothing to look up and would answer [] silently) or when the index is
 *   absent or not the governed one (`"index_unavailable"`). The reader never
 *   builds it -- the writer does, in `indexRevisionChunks`.
 *
 * ORDER (overnight R22, docs/overnight/DECISIONS.md): `search_chunks_v1` has
 * ONE FTS index shared by every workspace, and BM25's IDF and average document
 * length are computed over all of it. So BM25 may only SELECT candidates, and
 * even that as little as possible: each source (index, seam scan, scan) is
 * read ONCE for up to `FTS_CANDIDATE_CEILING` workspace-prefiltered candidate
 * chunks -- all of them, unless the workspace holds more -- and the WHOLE set
 * is ordered by `keywordHitOrder` before `limit` applies: occurrences of the
 * query in the node's current head text (`countFolded`, R14's case-folded
 * rule), descending; then the head's acceptance instant
 * (`node_revisions.created_at`), descending; then node id. `hits[].rank` (R21)
 * is the 1-based position in that order, no raw score is ever on the wire,
 * and a bounded answer is the head of the unbounded one.
 *
 * The bound, stated rather than hidden: while the workspace holds fewer than
 * `FTS_CANDIDATE_CEILING` candidate chunks for the query, every one is read
 * and the answer is a function of this workspace's rows alone. A candidate is
 * any chunk sharing a trigram -- stale revisions, retired and superseded
 * nodes and every embedding profile included -- so this counts chunks, not
 * matches. Past it the index read holds BM25's corpus-wide top
 * `FTS_CANDIDATE_CEILING`, so which of this workspace's nodes are considered
 * can move with another workspace's writes, and BM25 ties make even identical
 * datasets differ (`search-chunk-retrieval-candidate-ceiling.test.ts`); the
 * scans read the first ones in node-id order instead, which stays
 * workspace-local. A per-workspace index closes it. Semantic search's
 * `distance` has no such leak (the `search-chunk-v1.md` R21 amendment) and
 * keeps its own overfetch and order.
 *
 * Candidates are chunks; answers are NODES: `chunkMayHoldQuery` first drops,
 * without a read, every chunk no occurrence can touch; each surviving chunk
 * must then belong to its node's captured head revision, whose text holds the
 * query, on a recall-eligible node (`currentEligibleChunks`, which asks the
 * costly #29 seam only down R22's order, until `limit` nodes pass), and a
 * node's chunks collapse into one hit. Every read is scoped to the workspace.
 * Keyword and semantic answers are never fused (R7).
 *
 * COVERAGE (#30, `search-chunk-v1.md` section 21): the answer says when the
 * bound above was reached. Any source read that came back holding the whole
 * `ceiling` -- counted as read, before `chunkMayHoldQuery` drops a row --
 * makes it `coverage: "partial"`, `coverage_reason: "candidate_ceiling"`; a
 * full read cannot tell whether more existed. `ceiling` is
 * `FTS_CANDIDATE_CEILING`; only tests inject another.
 */
export async function searchKnowledgeKeyword(
  reader: DatasetAdapter,
  requestBytes: Uint8Array,
  requestTimeMs?: number,
  ceiling: number = FTS_CANDIDATE_CEILING,
) {
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

  /** Whether any candidate read came back holding the whole ceiling. */
  let saturated = false;
  /** Candidate rows -> the chunks an occurrence can touch. No candidate keeps
   *  a source rank: the index's BM25 `_score` is never read. */
  const candidates = (rows: Record<string, unknown>[]): RankedChunk[] => {
    if (rows.length >= ceiling) saturated = true;
    return rows.map((row) => rankedChunk(row, null)).filter((chunk) => chunkMayHoldQuery(chunk.text, chunk.chunk_index, query));
  };
  /** Every chunk matching `predicate`, up to the ceiling, in node-id order: the unranked scans. */
  const scan = (predicate: string) =>
    reader.orderedProjection(SEARCH_CHUNKS, `(${scope}) AND ${predicate}`, [...SEARCH_HIT_COLUMNS], { column: "node_id", ascending: true }, ceiling);

  let fromIndex: RankedChunk[] = [];
  let fromScan: RankedChunk[] = [];
  if (indexed) {
    fromIndex = candidates(await reader.fullTextSearchChunks(query, scope, ceiling));
    const seam = seamPredicate(query);
    if (codePoints <= SEAM_ONLY_MAX_CODE_POINTS && seam !== null) fromScan = candidates(await scan(seam));
  } else {
    fromScan = candidates(await scan(keywordScanPredicate(query)));
  }

  // One ordered pass over every candidate: the first `limit` eligible nodes
  // in R22's order, and only those, come back.
  const kept = await currentEligibleChunks(reader, request.workspace_name, query, requestTimeMs)([...fromIndex, ...fromScan], limit);
  // A node the index found is an index hit, shown by its index chunks; the
  // seam scan adds only the nodes the index could not see.
  const indexIds = new Set(fromIndex.map((chunk) => chunk.id));
  const indexNodes = new Set(kept.chunks.filter((chunk) => indexIds.has(chunk.id)).map((chunk) => chunk.node_id));
  const shown = kept.chunks.filter((chunk) => indexIds.has(chunk.id) || !indexNodes.has(chunk.node_id));
  const hits: OrderedHit[] = groupKnowledgeHits(shown, kept.heads, "descending", query)
    .map((hit) => {
      const { occurrences, accepted_at } = kept.heads.get(hit.node_id)!;
      // A keyword head always carries both keys; one without them is a bug, never a guess.
      if (occurrences === undefined || accepted_at === undefined) failPublication("integrity_failure", "");
      const found: FtsMatch = indexNodes.has(hit.node_id) ? "ngram" : "substring_scan";
      return { ...hit, occurrences, accepted_at, found };
    })
    .sort(keywordHitOrder);

  return {
    match,
    scan_reason: scanReason,
    // Whether every candidate was read (section 21): the bound, never a count.
    ...coverageSignal(saturated, ceiling),
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
