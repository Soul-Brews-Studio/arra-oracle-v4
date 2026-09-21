import { failPublication } from "./errors";

/** Exactly one row, or a distinguishable 0 / >1 outcome. Never `limit(1)`. */
export function exactlyOne<T>(rows: T[], path = ""): T | null {
  if (rows.length === 0) return null;
  // >1 means duplicate logical identity: an integrity failure, never a pick.
  if (rows.length > 1) failPublication("integrity_failure", path);
  return rows[0]!;
}
