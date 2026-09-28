// Split out of read-cursor.ts (Nat style: one exported function per file).
// Shared by read-cursor.validateWorkspaceRow.ts and
// read-cursor.encodeReadCursorRow.ts.

import { failPublication } from "./errors";
import { MAX_NAME_BYTES } from "./read-cursor.constants";
import { storedText } from "./read-cursor.storedText";

export function storedName(value: unknown): string {
  const text = storedText(value);
  if (text.length === 0) failPublication("integrity_failure", "");
  // The same bound the request grammar applies, measured in UTF-8 BYTES: a
  // stored name past it could never have been written through this service.
  if (new TextEncoder().encode(text).length > MAX_NAME_BYTES) {
    failPublication("integrity_failure", "");
  }
  return text;
}
