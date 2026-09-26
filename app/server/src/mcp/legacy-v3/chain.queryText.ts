import type { HeadFacts } from "./search.describeHead";

/** The kernel's search-query cap (search-chunk-v1.md §13: at most 4096 UTF-8 bytes). */
const MAX_QUERY_BYTES = 4096;

/**
 * The text a later chain hop searches by: the entry's own head text, `title`,
 * a blank line, `body` -- the string its chunks were cut from, so its
 * re-embedded vector is the nearest thing to the stored one v3 queried by id
 * (arra-oracle-v3 src/tools/search/chain.ts: `queryById`). The semantic
 * kernel takes text, not a vector, so this is how v4 carries that hop.
 * Truncated to the query cap on a code point boundary.
 */
export function queryText(facts: HeadFacts): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let text = "";
  for (const point of `${facts.title}\n\n${facts.body}`) {
    bytes += encoder.encode(point).length;
    if (bytes > MAX_QUERY_BYTES) break;
    text += point;
  }
  return text;
}
