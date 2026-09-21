import { failPublication } from "./errors";

/** Raw Arrow cell -> microseconds. No Date fallback: a Date has ALREADY lost
 *  whatever sub-millisecond precision the timestamp[us] column held. */
export function rawMicros(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure");
    return BigInt(value);
  }
  return failPublication("integrity_failure");
}
