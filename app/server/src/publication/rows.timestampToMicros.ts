import { failPublication } from "./errors";
import { MICROS_PER_MILLI } from "./rows.constants";

/** Exact UTC millisecond string -> storage microseconds, with no float math. */
export function timestampToMicros(text: unknown): bigint {
  if (typeof text !== "string" || text.length !== 24) failPublication("integrity_failure");
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(text)) {
    failPublication("integrity_failure");
  }
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) failPublication("integrity_failure");
  const parsed = new Date(millis);
  if (parsed.toISOString() !== text) failPublication("integrity_failure");
  // Integer BigInt multiply: never `millis * 1000` in floating point.
  return BigInt(millis) * MICROS_PER_MILLI;
}
