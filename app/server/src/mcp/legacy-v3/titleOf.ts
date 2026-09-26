/**
 * A node title from free text: the first non-blank line, any leading markdown
 * heading marks removed, at most 80 characters (v3 list.ts:120 took the first
 * line's first 80). Code points, not UTF-16 units, so Thai and emoji are not
 * split mid-character.
 */
export function titleOf(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  const bare = line.replace(/^#+\s*/, "").trim() || line;
  return Array.from(bare).slice(0, 80).join("");
}
