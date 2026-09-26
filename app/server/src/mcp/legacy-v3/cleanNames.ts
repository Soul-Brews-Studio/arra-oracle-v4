/**
 * v3 concept lists, cleaned the way v3 cleaned them: strings only, trimmed,
 * blanks dropped, first occurrence kept. The kernel itself normalizes nothing
 * (V3-PARITY.md §3 A4), so this is adapter input handling, not a domain rule.
 */
export function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (name !== "" && !out.includes(name)) out.push(name);
  }
  return out;
}
