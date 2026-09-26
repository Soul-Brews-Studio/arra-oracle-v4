/**
 * What a keyword hit is ordered by (overnight R22): three facts about the
 * node's CURRENT head revision in the requesting workspace, and nothing a
 * shared index statistic can move.
 */
export type KeywordOrderKey = {
  /** `countFolded(head text, query)`: R14's case-folded rule, non-overlapping. */
  occurrences: number;
  /** The head revision's `created_at` -- the instant `publishRevision`
   *  accepted it -- as the raw `timestamp[us]` microseconds. */
  accepted_at: bigint;
  node_id: string;
};

/**
 * The keyword answer's order (overnight R22, docs/overnight/DECISIONS.md):
 *
 * 1. more occurrences of the query in the head text first;
 * 2. then the later-accepted head first (exact microseconds, compared as
 *    bigint, never through a lossy Number);
 * 3. then node id ascending, by UTF-16 code unit (`<`, the same comparison as
 *    every other node-id tie-break in this module).
 *
 * `node_id` is unique within one answer (one hit per node), so this is a total
 * order: every permutation of the same hits sorts to one sequence, and `rank`
 * is the 1-based position in it. BM25 over the FTS index shared by every
 * workspace only picks candidates; it has no say here, because its IDF and
 * average document length are corpus-wide (R21 measured the raw score moving
 * 5.65 -> 2.38, R22 the order A3,A1,A2 -> A3,A2,A1, both on other-workspace
 * writes alone).
 */
export function keywordHitOrder(a: KeywordOrderKey, b: KeywordOrderKey): number {
  if (a.occurrences !== b.occurrences) return a.occurrences > b.occurrences ? -1 : 1;
  if (a.accepted_at !== b.accepted_at) return a.accepted_at > b.accepted_at ? -1 : 1;
  return a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0;
}
