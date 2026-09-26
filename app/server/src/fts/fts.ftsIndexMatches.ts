import { FTS_INDEX_OPTIONS } from "./fts.constants";

/** The keys `listIndices()[i].indexDetails` reports for each governed option. */
const GOVERNED = Object.freeze({
  base_tokenizer: FTS_INDEX_OPTIONS.baseTokenizer,
  min_ngram_length: FTS_INDEX_OPTIONS.ngramMinLength,
  max_ngram_length: FTS_INDEX_OPTIONS.ngramMaxLength,
  prefix_only: FTS_INDEX_OPTIONS.prefixOnly,
  stem: FTS_INDEX_OPTIONS.stem,
  remove_stop_words: FTS_INDEX_OPTIONS.removeStopWords,
});

/**
 * Whether a LIVE index already is the one `FTS_INDEX_OPTIONS` would build.
 *
 * Read from the engine's own `indexDetails`, never from the call site that
 * built it (SPEC §4.1.2: "verify with listIndices, not by trusting the call
 * site"). Keys outside the governed set (block_size, lower_case, ...) are
 * ignored. Details that are missing or arrive as an unparsed string are a
 * mismatch: an index this code cannot read back is not assumed faithful.
 */
export function ftsIndexMatches(details: unknown): boolean {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return false;
  const live = details as Record<string, unknown>;
  return Object.entries(GOVERNED).every(([key, expected]) => live[key] === expected);
}
