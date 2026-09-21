import { requireTimestampString, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";

/**
 * Both `session_from_ts`/`session_to_ts` (millisecond storage) and
 * `captured_at` (microsecond storage) share the SAME wire grammar: exact
 * UTC-ms text, years 1..9999. `requireTimestampString` (-> `v1.parseTimestamp`)
 * is the ACCEPTED governed check for that grammar and, critically, rejects a
 * leading "0000" year that the length+regex+round-trip checks in this
 * module's own `timestampToMillis` and `./rows`' `timestampToMicros` do NOT
 * reject on their own -- those two converters check SHAPE, not the calendar
 * floor. Validating through the governed helper HERE, before either
 * unit-specific converter ever runs, is what keeps a year-0000 value from
 * reaching a write at all: it fails invalid_value at the FIELD POINTER,
 * never integrity_failure at root, and never inside the post-write window.
 */
export function nullableTimestamp(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireTimestampString(v, tokens);
}
