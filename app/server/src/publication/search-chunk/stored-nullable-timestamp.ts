import { failPublication } from "../errors";
import { microsToTimestamp } from "../rows";

/** Raw microseconds to the exact wire millisecond string, or explicit null. */
export function storedNullableTimestamp(value: unknown): string | null {
  // EXPLICIT null only. `undefined` in a present column is a malformed row,
  // and reading it as "no timestamp" would invent an absence the data never
  // stated -- the same distinction `read-cursor.ts`'s `storedPointer` draws.
  if (value === null) return null;
  if (typeof value === "bigint") return microsToTimestamp(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return microsToTimestamp(BigInt(value));
  }
  return failPublication("integrity_failure", "");
}
