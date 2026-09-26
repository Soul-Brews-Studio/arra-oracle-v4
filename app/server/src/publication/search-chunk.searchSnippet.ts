/** Length of a hit's snippet, in code points. */
export const SNIPPET_CODE_POINTS = 160;
/** How much text before the first occurrence a keyword snippet keeps. */
const LEAD_CODE_POINTS = 40;

/**
 * A window of one chunk's text for a hit.
 *
 * Counted in CODE POINTS (`[...text]`), so an astral character is never cut in
 * half and a Thai vowel or tone mark counts as the character it is. With a
 * `query`, the window opens a little before its first case-folded occurrence;
 * without one (semantic), or when it cannot be located, it is the chunk's
 * opening. The location is trusted only when folding kept the text's length:
 * a character that lower-cases into two (`İ`) would shift every later offset,
 * and a wrong window is worse than the opening one.
 */
export function searchSnippet(text: string, query: string | null): string {
  const points = [...text];
  if (points.length <= SNIPPET_CODE_POINTS) return text;
  let start = 0;
  if (query !== null) {
    const folded = text.toLowerCase();
    const at = folded.length === text.length ? folded.indexOf(query.toLowerCase()) : -1;
    if (at > 0) {
      const before = [...text.slice(0, at)].length;
      start = Math.max(0, Math.min(before - LEAD_CODE_POINTS, points.length - SNIPPET_CODE_POINTS));
    }
  }
  return points.slice(start, start + SNIPPET_CODE_POINTS).join("");
}
