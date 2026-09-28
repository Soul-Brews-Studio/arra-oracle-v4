// Split out of read-cursor.ts (Nat style: one exported function per file).
// Shared by read-cursor.validateWorkspaceRow.ts and
// read-cursor.encodeReadCursorRow.ts.

import { failPublication } from "./errors";

/**
 * EXACTLY these columns: present, own, and nothing else.
 *
 * Presence alone is not the contracted shape -- an unknown column means the
 * row is not what this codec describes, and encoding it anyway would vouch
 * for state it never examined. `in` walks the prototype chain, so a row
 * missing a real column could otherwise look complete and then be encoded
 * from prototype data; `Object.prototype.hasOwnProperty.call` rather than the
 * row's own method, which a stored row could shadow.
 */
export function requireExactColumns(row: unknown, fields: readonly string[]): Record<string, unknown> {
  // A malformed CONTAINER is refused before any field is read: an array or a
  // primitive is not a row, whatever it may happen to answer to.
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    failPublication("integrity_failure", "");
  }
  const actual = Object.keys(row as Record<string, unknown>);
  if (actual.length !== fields.length) failPublication("integrity_failure", "");
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) {
      failPublication("integrity_failure", "");
    }
  }
  return row as Record<string, unknown>;
}
