// Split from chat.ts (style-split4b, 2026-09-28).
import { requireBoundedText, requireNonemptyString, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";
import { MAX_QUESTION_BYTES } from "./chat.state";

/** Nonempty valid Unicode, bounded, exactly like `name` but its own bound:
 *  a question is not a scoped identity and must not borrow that grammar. */
export function question(value: JcsValue | undefined, tokens: Tokens): string {
  return requireBoundedText(requireNonemptyString(value ?? null, tokens), MAX_QUESTION_BYTES, tokens);
}
