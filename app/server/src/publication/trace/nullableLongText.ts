import { requireBoundedText, requireNonemptyString, type Tokens } from "../../contracts/common";
import type { JcsValue } from "../../contracts/jcs";

const MAX_LONG_TEXT_BYTES = 65536;

export function nullableLongText(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireBoundedText(requireNonemptyString(v, tokens), MAX_LONG_TEXT_BYTES, tokens);
}
