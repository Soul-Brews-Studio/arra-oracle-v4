/**
 * The ONE lexical index configuration (R14, and R7 as amended 21:40 --
 * docs/overnight/DECISIONS.md). Every FTS index this server builds, on the
 * legacy `memories.content` today and on the #30 chunk text later, is built
 * from this constant, so the two stores cannot drift onto different tokenizers.
 *
 * Why these values, each measured on @lancedb/lancedb 0.38.0 (#10, SPEC §4.1.2):
 *
 * - `ngram` 3..3 is character trigrams over the whole text. It is the only
 *   buildable tokenizer that finds Thai inside a word: ลืม inside หลงลืม.
 *   `icu` segments whole words and returns 0 for it; `trigram` and `unicode61`
 *   are refused by the SDK outright.
 * - `stem` and `removeStopWords` DEFAULT TO TRUE and stop-word removal runs
 *   even in ngram mode (`the` -> [] under defaults). Both are turned off, or
 *   the index is not a faithful trigram index.
 * - `prefixOnly: false` keeps every trigram, not just word prefixes.
 *
 * Reverse by changing this constant (and `ftsIndexMatches` follows); the
 * `fts-*` tests name what each setting buys.
 */
export const FTS_INDEX_OPTIONS = Object.freeze({
  baseTokenizer: "ngram",
  ngramMinLength: 3,
  ngramMaxLength: 3,
  prefixOnly: false,
  stem: false,
  removeStopWords: false,
} as const);

/**
 * Below this many code points a trigram index has no token to look up and
 * returns nothing, silently (measured: ล and ลื -> [], ลืม -> hit). Such a
 * query becomes a bounded substring scan instead, and says so.
 */
export const FTS_MIN_QUERY_CODE_POINTS = FTS_INDEX_OPTIONS.ngramMinLength;

/**
 * Substring verification overfetch. The first fetch is `limit * FACTOR`
 * candidates; while fewer than `limit` of them verify and the index had more
 * to give, the fetch doubles, never past CEILING. A true match buried under
 * more than CEILING over-matching candidates is therefore not returned --
 * that is the bound, stated rather than hidden.
 */
export const FTS_CANDIDATE_FACTOR = 4;
export const FTS_CANDIDATE_CEILING = 4096;

/**
 * How a lexical answer was produced, reported on the wire so a caller can
 * tell a trigram lookup from the short-query scan (SPEC §4.1.2: "fall back to
 * LIKE and say so").
 */
export type FtsMatch = "ngram" | "substring_scan";
export type FtsResult<Row> = { readonly match: FtsMatch; readonly rows: Row[] };
