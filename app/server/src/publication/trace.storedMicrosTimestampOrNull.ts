import { failPublication } from "./errors";
import { microsToTimestamp } from "./rows";

/**
 * RAW storage MICROSECONDS, `bigint` ONLY, nullable. This is the ONLY place
 * in this kernel that touches `./rows`' micros helpers, and it is used for
 * `trace_hits.captured_at` exclusively.
 *
 * No `number` fallback (#105): a plain JS `number` here can only be a lossy
 * MILLISECOND read from the client's `toArray()`/`.get()` accessor mistaken
 * for microseconds -- see `context.rawMicros.ts` for the full rationale.
 */
export function storedMicrosTimestampOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "bigint") return microsToTimestamp(value);
  return failPublication("integrity_failure", "");
}
