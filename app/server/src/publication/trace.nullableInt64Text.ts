import { requireNonNegativeInt64String, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";

export function nullableInt64Text(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireNonNegativeInt64String(v, tokens).text;
}
