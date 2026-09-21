import { fail } from "./errors";
import type { JcsValue } from "./jcs";
import type { Tokens } from "./common";

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT64_SYNTAX = /^(?:0|-?[1-9][0-9]*)$/;

/**
 * Local Int64 validator. `requireInt64String` (common.ts, shared and
 * unchanged) folds malformed syntax AND out-of-range magnitude into one
 * `invalid_value` for its existing callers. Section9's table requires the
 * split: a syntactically canonical decimal string that is simply too large
 * or too small is `out_of_range`, not `invalid_value`. Only genuinely
 * malformed spelling -- leading zeros, a sign on zero, whitespace, non-digit
 * characters, or a string too long to be a plausible int64 -- is
 * `invalid_value`. Mirrors the shared length/regex rule so a boundary value
 * like the exact INT64_MIN literal is not misclassified by an over-eager
 * length cutoff.
 */
export function requireInt64Ranged(value: JcsValue, tokens: Tokens): { text: string; value: bigint } {
  if (typeof value !== "string") fail("invalid_type", tokens, "int64 must be a canonical decimal string");
  // Canonical SYNTAX first, independent of length: leading zero, a sign on
  // zero, non-digit characters, or surrounding whitespace is invalid_value
  // regardless of how long the malformed text is.
  if (value !== value.trim() || !INT64_SYNTAX.test(value)) {
    fail("invalid_value", tokens, "int64 requires canonical decimal text");
  }
  // The text is canonically formed. A canonical decimal LONGER than 20
  // characters is GUARANTEED to exceed the signed 64-bit range -- the longest
  // valid boundary, MIN_I64 = "-9223372036854775808", is exactly 20 characters
  // including its sign -- so this is out_of_range WITHOUT ever constructing a
  // BigInt from an arbitrarily long digit string.
  if (value.length > 20) {
    fail("out_of_range", tokens, "int64 is outside the signed 64-bit range");
  }
  const parsed = BigInt(value);
  if (parsed < INT64_MIN || parsed > INT64_MAX) {
    fail("out_of_range", tokens, "int64 is outside the signed 64-bit range");
  }
  return { text: value, value: parsed };
}
