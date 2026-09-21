import { fail } from "../../contracts/errors";
import type { Tokens } from "../../contracts/common";
import { MIN_EPOCH_MS, MAX_EPOCH_MS } from "./constants";

/** Exact UTC millisecond wire string to RAW storage milliseconds. Throws the
 *  GOVERNED `ContractError` (via `fail`), not `PublicationError`: this is
 *  used from the request grammar as well as from the stored-row codec, and
 *  the caller decides which envelope applies. */
export function timestampToMillis(text: unknown, tokens: Tokens = []): bigint {
  if (typeof text !== "string" || text.length !== 24) {
    fail("invalid_type", tokens, "expected exact UTC-ms timestamp text");
  }
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(text)) {
    fail("invalid_value", tokens, "expected exact UTC-ms timestamp text");
  }
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) fail("invalid_value", tokens, "timestamp does not parse");
  const parsed = new Date(millis);
  if (parsed.toISOString() !== text) fail("invalid_value", tokens, "timestamp is not canonical");
  const value = BigInt(millis);
  // DEFENSE IN DEPTH, not the only guard: `requireTimestampString` at the
  // request-grammar call site (`nullableTimestamp`) already rejects a
  // leading "0000" year via `v1.parseTimestamp`. This second, independent
  // check is what stops a DIRECT caller of this exported converter --
  // shape+round-trip alone accepts "0000-06-15T12:00:00.000Z" (Date.parse
  // round-trips it identically), which is BELOW MIN_EPOCH_MS. Governed
  // invalid_value at the field pointer, never integrity_failure at root.
  if (value < MIN_EPOCH_MS || value > MAX_EPOCH_MS) {
    fail("invalid_value", tokens, "timestamp must be within years 1..9999");
  }
  return value;
}
