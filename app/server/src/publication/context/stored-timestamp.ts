import { failPublication } from "../errors";
import { rawMicros } from "./raw-micros";

const MICROS_PER_MILLI = 1000n;
/** Gregorian 0001-01-01 .. 9999-12-31T23:59:59.999, in epoch milliseconds.
 *  The SUPPORTED range, which is narrower than what JS Date will render --
 *  Date happily prints +010000-01-01T00:00:00.000Z for year 10000. */
const MIN_EPOCH_MS = -62135596800000n;
const MAX_EPOCH_MS = 253402300799999n;

/** Exact UTC millisecond text. The remainder is rejected BEFORE any Number
 *  conversion, so a stored time is never rounded into one the store lacks. */
export function storedTimestamp(value: unknown): string {
  const micros = rawMicros(value);
  if (micros % MICROS_PER_MILLI !== 0n) failPublication("integrity_failure");
  const millis = micros / MICROS_PER_MILLI;
  // The SUPPORTED range, not the JS Date range.
  if (millis < MIN_EPOCH_MS || millis > MAX_EPOCH_MS) failPublication("integrity_failure");
  const text = new Date(Number(millis)).toISOString();
  if (Date.parse(text) !== Number(millis)) failPublication("integrity_failure");
  return text;
}
