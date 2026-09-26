/**
 * How many times `q` occurs in `text` under the SAME rule `containsFolded`
 * admits a match by: both sides `toLowerCase()`d, the whole text at once (so
 * final sigma folds exactly as it does there). Occurrences are counted left
 * to right and never overlap -- after a match the scan resumes past it
 * (`"aaaa"` holds `"aa"` twice), the `split` / Python `str.count` convention.
 * For a non-empty `q`, `countFolded(text, q) > 0` exactly when
 * `containsFolded(text, q)`; an empty `q` is never an occurrence (the keyword
 * parser refuses a query with no non-whitespace character before this runs).
 *
 * Overnight R22's first ordering key for keyword hits (the node whose head
 * text holds the query more often comes first). It reads one node's own text
 * and nothing else, so no other row, in this workspace or another, moves it.
 */
export function countFolded(text: string, q: string): number {
  const haystack = text.toLowerCase();
  const needle = q.toLowerCase();
  if (needle.length === 0) return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}
