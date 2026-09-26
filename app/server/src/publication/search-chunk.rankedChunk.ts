import { failPublication } from "./errors";

/** One retrieval candidate: a chunk and the rank its source gave it. */
export type RankedChunk = {
  id: string;
  node_id: string;
  revision_id: string;
  chunk_index: bigint;
  text: string;
  /** Squared-L2 `_distance` (semantic; lower is better), or null. Keyword
   *  search keeps no source rank at all: overnight R22 orders its hits by the
   *  node's own head text, never by the shared index's BM25 `_score`. */
  rank: number | null;
};

/**
 * Read one candidate row (raw Arrow decode of `SEARCH_HIT_COLUMNS` plus the
 * source's own rank column) into a `RankedChunk`. A projected row that is not
 * this shape is stored corruption -- the columns are NOT NULL -- and is
 * refused, never skipped.
 */
export function rankedChunk(row: Record<string, unknown>, rank: unknown): RankedChunk {
  const { id, node_id, revision_id, chunk_index, text } = row;
  if (
    typeof id !== "string" ||
    typeof node_id !== "string" ||
    typeof revision_id !== "string" ||
    typeof chunk_index !== "bigint" ||
    typeof text !== "string"
  ) {
    failPublication("integrity_failure", "");
  }
  if (rank !== null && (typeof rank !== "number" || !Number.isFinite(rank))) failPublication("integrity_failure", "");
  return { id, node_id, revision_id, chunk_index, text, rank: rank as number | null };
}
