import { failTaxonomy } from "./fail-taxonomy";

/** Raw Arrow cell -> microseconds. No Date fallback: a Date has already lost
 *  whatever sub-millisecond precision the timestamp[us] column held. */
export function rawMicros(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failTaxonomy("integrity_failure");
    return BigInt(value);
  }
  return failTaxonomy("integrity_failure");
}
