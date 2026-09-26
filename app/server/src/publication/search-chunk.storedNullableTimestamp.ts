import { failPublication } from "./errors";
import { microsToTimestamp } from "./rows";

/**
 * Raw microseconds to the exact wire millisecond string, or explicit null.
 * `bigint` ONLY (#105): a plain JS `number` here can only be a lossy
 * MILLISECOND read from the client's `toArray()`/`.get()` accessor mistaken
 * for microseconds -- see `context.rawMicros.ts` for the full rationale.
 */
export function storedNullableTimestamp(value: unknown): string | null {
  // EXPLICIT null only. `undefined` in a present column is a malformed row,
  // and reading it as "no timestamp" would invent an absence the data never
  // stated -- the same distinction `read-cursor.ts`'s `storedPointer` draws.
  if (value === null) return null;
  if (typeof value === "bigint") return microsToTimestamp(value);
  return failPublication("integrity_failure", "");
}
