/**
 * True for a supersession, false for a retirement. Call only on the result of
 * `encodeSupersedeLogRow`, which has already proven the new_id/new_revision_id
 * pair agrees.
 */
export function isSupersedeEvent(encoded: Record<string, unknown>): boolean {
  return encoded.new_id !== null;
}
