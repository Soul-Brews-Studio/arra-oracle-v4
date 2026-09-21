import {
  requireNonNegativeInt64String,
  requirePositiveInt64String,
  type Tokens,
} from "../../contracts/common";
import type { JcsValue } from "../../contracts/jcs";

/**
 * Canonical Int64 decimal TEXT, through the ACCEPTED helpers.
 *
 * An earlier version of this file re-implemented the grammar locally and
 * emitted `invalid_value` where the governed helpers emit `out_of_range` with
 * their own messages. That is a second parser with a divergent envelope, which
 * is exactly what the contract forbids -- and no path-only assertion could see
 * the difference.
 */
export function int64Text(
  value: JcsValue | undefined,
  tokens: Tokens,
  bound: "positive" | "nonnegative",
): string {
  const v = value ?? null;
  return bound === "positive"
    ? requirePositiveInt64String(v, tokens).text
    : requireNonNegativeInt64String(v, tokens).text;
}
