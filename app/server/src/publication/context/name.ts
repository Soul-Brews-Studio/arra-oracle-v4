import { requireBoundedText, requireNonemptyString, type Tokens } from "../../contracts/common";
import type { JcsValue } from "../../contracts/jcs";
import { MAX_NAME_BYTES } from "./constants";

/** Nonempty valid Unicode, 256 UTF-8 bytes. No trim, no case fold, no NFC. */
export function name(value: JcsValue | undefined, tokens: Tokens): string {
  return requireBoundedText(requireNonemptyString(value ?? null, tokens), MAX_NAME_BYTES, tokens);
}
