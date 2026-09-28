// Split out of read-cursor.ts (Nat style: one exported function per file).
// Contract: app/docs/contracts/read-cursor-v1.md

import { WORKSPACE_FIELDS } from "./read-cursor.constants";
import { requireExactColumns } from "./read-cursor.requireExactColumns";
import { storedName } from "./read-cursor.storedName";
import { storedText } from "./read-cursor.storedText";
import { storedTimestamp } from "./read-cursor.storedTimestamp";

/**
 * A physical REQUIRED STRING: utf8, NOT NULL, and nothing further.
 *
 * Deliberately not the name grammar. Nonempty and the 256-byte bound are peer
 * and session semantics; importing them here from resemblance would refuse
 * rows this slice has no authority to reject.
 *
 * Private: used only by validateWorkspaceRow within this file.
 */
function storedRequiredText(value: unknown): string {
  return storedText(value);
}

/**
 * EXPLICIT null, or valid Unicode text of any length.
 *
 * No invented bound: these columns carry opaque JSON documents, and the
 * physical schema states only utf8 nullable.
 *
 * Private: used only by validateWorkspaceRow within this file.
 */
function storedNullableText(value: unknown): string | null {
  if (value === null) return null;
  return storedText(value);
}

/**
 * Validate the SELECTED workspace row, structurally.
 *
 * There is no accepted workspace encoder to delegate to, so this is a bounded
 * private validator for the one row this operation already selected -- not a
 * general workspace API and not a corpus audit. It describes exactly the seven
 * physical columns and nothing more.
 *
 * `id` is a required nonempty string and deliberately NOT a nanoid: peers and
 * sessions carry that namespace, workspaces do not, and inventing the
 * requirement here from resemblance would be a new identity decision this
 * slice has no authority to make.
 */
export function validateWorkspaceRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, WORKSPACE_FIELDS);
  return {
    // A physical required string, NOT a name and NOT a nanoid: this slice
    // makes no new identity decision about workspace ids.
    id: storedRequiredText(row.id),
    name: storedName(row.name),
    // RAW micros through the accepted conversion: a sub-millisecond remainder
    // or an out-of-range value is corruption here exactly as it is on a cursor.
    created_at: storedTimestamp(row.created_at),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    configuration: storedNullableText(row.configuration),
    mission: storedNullableText(row.mission),
  };
}
