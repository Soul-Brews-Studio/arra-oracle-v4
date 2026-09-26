/** v3's own cap on FTS tokens for a query (arra-oracle-v3 src/server/handlers.ts:35); each term is one kernel call here. */
const MAX_TERMS = 8;
/** The trigram minimum (search-chunk-v1.md §13, R14): a shorter term is a substring scan. */
const MIN_TERM_CODE_POINTS = 3;

/**
 * A v3 keyword query as v4 keyword terms (V3-PARITY.md §4.4, R18 V5).
 *
 * v3 turned the query into word tokens joined with OR (FTS5; arra-oracle-v3
 * src/tools/search/helpers.ts:7-19), so an entry matched when it held ANY
 * word. The v4 kernel matches one case-folded SUBSTRING (search-chunk-v1.md
 * §13), so a multi-word v3 query sent whole would find only entries holding
 * the exact phrase. Each word becomes its own substring term instead.
 *
 * A word is a run of letters, combining marks, digits and `_`. v3's class had
 * no marks (`\p{M}`), which cut Thai at every vowel or tone mark (ลืม became
 * ล and ม); here a Thai run stays whole, so R14's inside-word match applies to
 * it. Words repeat case-insensitively only once, first spelling kept. A query
 * with no word at all (punctuation only) is one verbatim term.
 *
 * v3 matched whole tokens, so its `is` matched the word "is". A v4 substring
 * `is` matches inside "this" and "list" -- nearly every entry -- so in a query
 * that also has a word of 3 or more code points, shorter words are dropped. A
 * query of short words only keeps them (each is then a substring scan, and
 * the answer says so). Dropped words, and words past the cap, are returned as
 * `dropped` so the caller can name them.
 */
export function keywordTerms(query: string): { terms: string[]; dropped: string[] } {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const word of query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? []) {
    const folded = word.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    words.push(word);
  }
  if (words.length === 0) return { terms: [query.trim()], dropped: [] };
  const long = words.filter((word) => [...word].length >= MIN_TERM_CODE_POINTS);
  const usable = long.length > 0 ? long : words;
  const short = long.length > 0 ? words.filter((word) => [...word].length < MIN_TERM_CODE_POINTS) : [];
  return { terms: usable.slice(0, MAX_TERMS), dropped: [...short, ...usable.slice(MAX_TERMS)] };
}
