import { failPublication } from "./errors";

/**
 * Raw Arrow cell -> microseconds. `bigint` ONLY.
 *
 * No Date fallback: a Date has ALREADY lost whatever sub-millisecond
 * precision the timestamp[us] column held. No `number` fallback either
 * (#105): every legitimate raw microsecond value reaches this function as a
 * `bigint`, either straight from `decodeArrowRows`/`rawRows` (storage.ts,
 * which reads the physical `BigInt64Array` directly) or from a freshly built
 * row whose timestamp field was constructed as `BigInt(clock()) * 1000n`. A
 * plain JS `number` here can only have come from the client's lossy
 * `toArray()`/`.get()` accessor, which returns MILLISECONDS
 * (LANCEDB-FACTS.md §1) -- accepting it as-is would silently mislabel a
 * millisecond value as microseconds, understating it 1000x, instead of
 * failing closed.
 */
export function rawMicros(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  return failPublication("integrity_failure");
}
