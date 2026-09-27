import { failPublication } from "./errors";
import { MAX_EPOCH_MS, MICROS_PER_MILLI, MIN_EPOCH_MS } from "./rows.constants";

/**
 * Convert raw storage microseconds to an exact UTC millisecond string.
 *
 * A non-zero remainder is refused, not rounded: the physical column can hold
 * microsecond precision this wire format cannot express, and silently
 * dropping it would make a lossy round trip look successful.
 */
export function microsToTimestamp(micros: bigint): string {
  if (micros % MICROS_PER_MILLI !== 0n) failPublication("integrity_failure");
  const millis = micros / MICROS_PER_MILLI;
  if (millis < MIN_EPOCH_MS || millis > MAX_EPOCH_MS) failPublication("integrity_failure");
  const text = new Date(Number(millis)).toISOString();
  // Round-trip guard: reject anything Date could not represent exactly.
  if (Date.parse(text) !== Number(millis)) failPublication("integrity_failure");
  return text;
}
