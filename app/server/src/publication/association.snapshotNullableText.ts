import { failPublication } from "./errors";

export function snapshotNullableText(value: unknown): string | null {
  // EXPLICIT null only. Treating `undefined` as null would fabricate a missing
  // nullable field into a legitimate one, so an absent key is stored-state
  // corruption rather than a silent null.
  if (value === null) return null;
  // EMPTY is a retained display value, not an absent one.
  if (typeof value !== "string") failPublication("integrity_failure");
  return value;
}
