import { requireTimestampString, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";

export function nullableCapturedAt(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireTimestampString(v, tokens);
}
