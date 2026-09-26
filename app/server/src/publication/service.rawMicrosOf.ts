import { failPublication } from "./errors";

/**
 * Raw Arrow cell -> microseconds. `bigint` ONLY (#105): see
 * `context.rawMicros.ts` for the full rationale. A plain JS `number` here can
 * only be a lossy MILLISECOND read from the client's `toArray()`/`.get()`
 * accessor mistaken for microseconds, which would silently understate it
 * 1000x instead of failing closed.
 */
export function rawMicrosOf(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  return failPublication("integrity_failure", "");
}
