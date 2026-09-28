// Split out of read-cursor.ts (Nat style: one exported function per file).
// Contract: app/docs/contracts/read-cursor-v1.md

import { failPublication } from "./errors";
import { READ_CURSOR_FIELDS } from "./read-cursor.constants";
import { requireExactColumns } from "./read-cursor.requireExactColumns";
import { storedName } from "./read-cursor.storedName";
import { storedTimestamp } from "./read-cursor.storedTimestamp";

/**
 * Private: used only by encodeReadCursorRow within this file.
 */
function storedPointer(value: unknown): string | null {
  // EXPLICIT null only. `undefined` in a present column is a malformed row,
  // and reading it as "no pointer" would invent an absence the data never
  // stated -- the same distinction the request grammar draws.
  if (value === null) return null;
  if (typeof value !== "string") failPublication("integrity_failure", "");
  // A retained pointer must itself satisfy the declared namespace. A malformed
  // one is terminal through this interface rather than silently converted.
  if (!/^[A-Za-z0-9_-]{21}$/.test(value)) failPublication("integrity_failure", "");
  return value;
}

/** One stored row to its exact five wire fields, in physical order. */
export function encodeReadCursorRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, READ_CURSOR_FIELDS);
  return {
    workspace_name: storedName(row.workspace_name),
    peer_name: storedName(row.peer_name),
    session_name: storedName(row.session_name),
    last_read_message_id: storedPointer(row.last_read_message_id),
    last_read_at: storedTimestamp(row.last_read_at),
  };
}
