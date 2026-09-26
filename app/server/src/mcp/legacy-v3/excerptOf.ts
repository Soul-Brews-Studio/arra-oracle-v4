/**
 * A v3-shaped excerpt: the first `maxCodePoints` CODE POINTS, never UTF-16
 * units, so Thai and emoji are not split mid-character -- the same rule
 * `titleOf.ts` states for a title. v3's own truncation was
 * `content.substring(0, 500)` (list.ts:121 / inbox.ts:72, both UTF-16); this
 * is the code-point-safe equivalent this codebase already uses elsewhere.
 */
export function excerptOf(text: string, maxCodePoints: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= maxCodePoints ? text : codePoints.slice(0, maxCodePoints).join("");
}
