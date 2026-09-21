import { requireUnicodeString, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";

/**
 * A description is ANY valid Unicode string, or null.
 *
 * Deliberately NOT bounded at 256 and deliberately allowed to be empty: the
 * request byte cap is its only bound. An earlier version of this file applied
 * the name rules here, which would have rejected both an empty description and
 * a long one that the contract accepts.
 */
export function requireNullableDescription(value: JcsValue | undefined, tokens: Tokens): string | null {
  return value === null ? null : requireUnicodeString(value ?? null, tokens);
}
