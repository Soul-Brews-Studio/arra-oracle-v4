import { failPublication } from "./errors";

/**
 * Normalise one raw Arrow cell into a BigInt of microseconds. `bigint` ONLY.
 *
 * NO Date fallback, deliberately. A Date has ALREADY lost whatever
 * sub-millisecond precision the physical timestamp[us] column held, so
 * multiplying it back up by 1000 would manufacture a microsecond value and
 * present it as the stored one. Refusing forces the raw BigInt path, which
 * is the only source that can still prove exactness.
 *
 * NO `number` fallback either (#105): every legitimate raw microsecond value
 * reaches this function as a `bigint` (`decodeArrowRows`/`rawRows` read the
 * physical `BigInt64Array` directly; a freshly built row's timestamp field is
 * `BigInt(clock()) * 1000n`). A plain JS `number` here can only be a lossy
 * MILLISECOND read from the client's `toArray()`/`.get()` accessor mistaken
 * for microseconds, which would silently understate it 1000x instead of
 * failing closed.
 */
export function rawMicros(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  return failPublication("integrity_failure");
}
