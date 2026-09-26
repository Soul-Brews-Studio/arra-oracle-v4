import { FTS_MIN_QUERY_CODE_POINTS } from "../fts/fts.constants";
import { likeContainsPredicate } from "../fts/fts.likeContainsPredicate";
import { CHUNK_SIZE_CHARS } from "./search-chunk.chunkText";
import { seamPredicate } from "./search-chunk.seamPredicate";

/**
 * Below this many code points, a query is not cut into pieces: pieces
 * shorter than a trigram would match most chunks. The seam clauses cover it.
 */
const PIECES_FROM_CODE_POINTS = 2 * FTS_MIN_QUERY_CODE_POINTS;

/**
 * The `search_chunks_v1` filter of keyword search's SCAN path (a short
 * query, or no governed index): every chunk that can hold part of an
 * occurrence of `query` in its revision's text, so that no node whose head
 * text contains the query is missed because the occurrence crosses a chunk
 * boundary (`chunkText` cuts every 1000 code units, no overlap).
 *
 * - Under 6 code points: the chunk contains the whole query, OR it is the
 *   chunk after a cut (`seamPredicate`). Such a query spans at most two
 *   chunks.
 * - Otherwise the query is cut, by code points and as evenly as possible,
 *   into one more piece than the chunk boundaries an occurrence of it can
 *   cross -- boundaries are at least `CHUNK_SIZE_CHARS` code units apart, so
 *   an occurrence of `u` code units crosses at most `ceil((u - 1) / 1000)` of
 *   them. Each boundary cuts at most one piece, so some piece lies whole
 *   inside one chunk, which contains it. Pieces are then at least 3 code
 *   points, which keeps the scan selective.
 *
 * A candidate is not an answer: the caller re-checks each node against its
 * whole head text (`containsFolded`).
 */
export function keywordScanPredicate(query: string): string {
  const points = [...query];
  if (points.length < PIECES_FROM_CODE_POINTS) {
    const seam = seamPredicate(query);
    const whole = likeContainsPredicate("text", query);
    return seam === null ? whole : `(${whole} OR ${seam})`;
  }
  const pieceCount = 1 + Math.ceil((query.length - 1) / CHUNK_SIZE_CHARS);
  const pieces = Array.from({ length: pieceCount }, (_, i) =>
    points.slice(Math.floor((i * points.length) / pieceCount), Math.floor(((i + 1) * points.length) / pieceCount)).join(""),
  );
  return `(${pieces.map((piece) => likeContainsPredicate("text", piece)).join(" OR ")})`;
}
