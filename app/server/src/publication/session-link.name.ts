// Split out of session-link.ts (Nat style: one exported function per file).
// Shared by session-link.parseCreateSessionLink.ts and
// session-link.parseListSessionLinks.ts.

import { requireBoundedText, requireNonemptyString, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";
import { MAX_NAME_BYTES } from "./session-link.constants";

/** Nonempty valid Unicode, 256 UTF-8 bytes. No trim, no case fold, no NFC. */
export function name(value: JcsValue | undefined, tokens: Tokens): string {
  return requireBoundedText(requireNonemptyString(value ?? null, tokens), MAX_NAME_BYTES, tokens);
}
