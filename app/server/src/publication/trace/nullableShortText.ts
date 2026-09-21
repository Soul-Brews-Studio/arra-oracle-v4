import { requireBoundedText, requireNonemptyString, type Tokens } from "../../contracts/common";
import type { JcsValue } from "../../contracts/jcs";
import { MAX_SHORT_TEXT_BYTES } from "./constants";

export function nullableShortText(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireBoundedText(requireNonemptyString(v, tokens), MAX_SHORT_TEXT_BYTES, tokens);
}
