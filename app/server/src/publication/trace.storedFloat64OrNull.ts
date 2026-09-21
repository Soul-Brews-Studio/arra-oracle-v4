import { failPublication } from "./errors";

export function storedFloat64OrNull(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number") failPublication("integrity_failure", "");
  // A stored NaN or Infinity has no JSON spelling; refused, never coerced to
  // null or to a sentinel number.
  if (!Number.isFinite(value)) failPublication("integrity_failure", "");
  return value;
}
