import { failTaxonomy } from "./taxonomy.failTaxonomy";
import { rawMicros } from "./taxonomy.rawMicros";
import { MICROS_PER_MILLI } from "./taxonomy.constants";

/** Exact UTC millisecond string, or integrity_failure. Remainder is rejected
 *  BEFORE any Number conversion, so a stored time is never rounded into a
 *  value the store does not hold. */
export function storedTimestamp(value: unknown): string {
  const micros = rawMicros(value);
  if (micros % MICROS_PER_MILLI !== 0n) failTaxonomy("integrity_failure");
  const millis = micros / MICROS_PER_MILLI;
  if (millis < -8640000000000000n || millis > 8640000000000000n) failTaxonomy("integrity_failure");
  const text = new Date(Number(millis)).toISOString();
  if (Date.parse(text) !== Number(millis)) failTaxonomy("integrity_failure");
  return text;
}
