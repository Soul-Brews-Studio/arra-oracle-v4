// Split out of read-cursor.ts (Nat style: one exported function per file).
// Shared by read-cursor.storedName.ts and read-cursor.storedTimestamp.ts's
// siblings within this split (validateWorkspaceRow and encodeReadCursorRow
// both need text validation), so it gets its own single-export file rather
// than living privately in either.

import { hasOnlyPairedSurrogates } from "../contracts/jcs";
import { failPublication } from "./errors";

/** Valid Unicode, through the ACCEPTED surrogate check. */
export function storedText(value: unknown): string {
  if (typeof value !== "string") failPublication("integrity_failure", "");
  // A lone surrogate is not valid Unicode and must not reach the wire as a
  // replacement character.
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure", "");
  return value;
}
