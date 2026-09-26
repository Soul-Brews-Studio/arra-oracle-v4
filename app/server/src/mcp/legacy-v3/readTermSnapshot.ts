/**
 * Read one vocabulary's term name out of a revision's frozen
 * `term_snapshot_json` (the shape `taxonomy.termSnapshot.ts` writes:
 * `{term_id, vocabulary_id, vocabulary_name_snapshot, term_name_snapshot,
 * label_snapshot, position}[]`, per V3-PARITY.md §3 A4/A5).
 *
 * Returns the FROZEN name from the snapshot, never a live re-lookup of the
 * term row: a revision's own terms are immutable once published, the same
 * way its body is (A1: this file does no table access and imports nothing
 * from `publication/*`; it only parses the JSON string the kernel already
 * handed back on the wire).
 *
 * `null` when the string does not parse, is not an array, or holds no entry
 * for `vocabularyName` -- never thrown, since a node published outside the
 * v3 adapter (or before a vocabulary existed) legitimately has none.
 */
export function readTermSnapshot(termSnapshotJson: unknown, vocabularyName: string): string | null {
  if (typeof termSnapshotJson !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(termSnapshotJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (row.vocabulary_name_snapshot === vocabularyName && typeof row.term_name_snapshot === "string") {
      return row.term_name_snapshot;
    }
  }
  return null;
}
