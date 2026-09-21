import { fail } from "../contracts/errors";
import type { Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";

export function nullableFriction(value: JcsValue | undefined, tokens: Tokens): number | null {
  const v = value ?? null;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    // NaN and Infinity have no JSON spelling and are refused, not coerced.
    fail("invalid_value", tokens, "expected a finite JSON number");
  }
  return v;
}
