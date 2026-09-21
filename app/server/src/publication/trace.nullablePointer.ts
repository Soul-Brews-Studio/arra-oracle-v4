import { requireNanoid21, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";

export function nullablePointer(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireNanoid21(v, tokens);
}
