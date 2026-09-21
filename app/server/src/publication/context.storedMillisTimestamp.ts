import { failPublication } from "./errors";

/** Gregorian 0001-01-01 .. 9999-12-31T23:59:59.999, in epoch milliseconds --
 *  matching `context.storedTimestamp.ts`'s range for the micros columns. */
const MIN_EPOCH_MS = -62135596800000n;
const MAX_EPOCH_MS = 253402300799999n;

/**
 * `mcp_calls.created_at` is raw int64 MILLISECONDS, not `timestamp[us]` --
 * the same unit trap `trace.ts` documents for `traces.created_at` (this
 * kernel's write side, `mcp/calls.ts`, writes it via plain `Date.now()`).
 * `context.storedTimestamp` is MICROS-only and would mis-scale this column by
 * 1000x, so this is a deliberately separate, millis-only converter -- do not
 * reuse `storedTimestamp` here.
 */
export function storedMillisTimestamp(value: unknown): string {
  let millis: bigint;
  if (typeof value === "bigint") millis = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure");
    millis = BigInt(value);
  } else return failPublication("integrity_failure");
  if (millis < MIN_EPOCH_MS || millis > MAX_EPOCH_MS) failPublication("integrity_failure");
  const text = new Date(Number(millis)).toISOString();
  if (Date.parse(text) !== Number(millis)) failPublication("integrity_failure");
  return text;
}
