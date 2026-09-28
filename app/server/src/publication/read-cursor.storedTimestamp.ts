// Split out of read-cursor.ts (Nat style: one exported function per file).
// Shared by read-cursor.validateWorkspaceRow.ts and
// read-cursor.encodeReadCursorRow.ts.

import { failPublication } from "./errors";
import { microsToTimestamp } from "./rows";

/**
 * RAW microseconds to the exact wire millisecond string.
 *
 * `last_read_at` carries no null spelling on the wire. A null, a
 * sub-millisecond remainder or an out-of-range value is stored-state
 * corruption, never rounded or clamped into something renderable -- and this
 * refusal holds whatever the physical engine does or does not admit, which is
 * why it is proven here rather than inferred from a column declaration.
 *
 * `bigint` ONLY (#105): a plain JS `number` here can only be a lossy
 * MILLISECOND read from the client's `toArray()`/`.get()` accessor mistaken
 * for microseconds -- see `context.rawMicros.ts` for the full rationale. This
 * is exactly the shape a workspace row seeded with a raw `number` timestamp
 * would take; failing closed here is what protects `validateWorkspaceRow`.
 */
export function storedTimestamp(value: unknown): string {
  if (typeof value === "bigint") return microsToTimestamp(value);
  return failPublication("integrity_failure", "");
}
