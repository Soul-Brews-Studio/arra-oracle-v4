import { failPublication } from "./errors";
import { microsToTimestamp } from "./rows";

/** RAW storage MICROSECONDS (bigint or safe-integer number), nullable. This
 *  is the ONLY place in this module that touches `./rows`' micros helpers,
 *  and it is used for `trace_hits.captured_at` exclusively. */
export function storedMicrosTimestampOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "bigint") return microsToTimestamp(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return microsToTimestamp(BigInt(value));
  }
  return failPublication("integrity_failure", "");
}
