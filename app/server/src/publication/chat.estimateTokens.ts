/**
 * Slice 10 (DESIGN.md §12: "never claim exact tokens without a tokenizer").
 *
 * This server has no tokenizer, so the context budget reports an ESTIMATE:
 * `ceil(utf8_bytes / 4)` over the JSON text of what was assembled. The
 * heuristic is named on the wire (`ContextBudget.estimate_heuristic`) so a
 * caller can replace it with a real count; it is never presented as exact.
 */
export function estimateTokens(wireBytes: number): number {
  return Math.ceil(wireBytes / 4);
}
