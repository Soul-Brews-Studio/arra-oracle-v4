/** Int64-decimal-text -> number: every count K6/K7's wire convention keeps
 *  as a string (so a huge dataset never rounds) becomes a plain number here,
 *  since the v3 shape wants one and V3-PARITY.md §2.5 names exactly this
 *  conversion. Shared by `oracle_concepts.ts` and `oracle_stats.ts` (fix
 *  round: was duplicated identically in both). */
export function safeNumber(text: string): number {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
}
