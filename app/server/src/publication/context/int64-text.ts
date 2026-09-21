import type { Tokens } from "../../contracts/common";
import { fail } from "../../contracts/errors";
import type { JcsValue } from "../../contracts/jcs";

/** Canonical signed Int64 decimal TEXT. Never a JSON number. */
export function int64Text(value: JcsValue | undefined, tokens: Tokens): string {
  if (typeof value !== "string") fail("invalid_type", tokens, "expected Int64 decimal string");
  // `-0` matches a naive `-?(0|[1-9]...)` and is NOT canonical: it is a second
  // spelling of zero, so a cursor could round-trip differently than it arrived.
  if (value === "-0" || !/^-?(0|[1-9][0-9]*)$/.test(value)) {
    fail("invalid_value", tokens, "expected canonical decimal");
  }
  const parsed = BigInt(value);
  if (parsed < -(2n ** 63n) || parsed > 2n ** 63n - 1n) fail("invalid_value", tokens, "outside Int64");
  return value;
}
