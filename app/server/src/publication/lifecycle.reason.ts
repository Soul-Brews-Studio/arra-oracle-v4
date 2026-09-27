import { requireBoundedText, requireNonemptyString, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";
import { MAX_REASON_BYTES } from "./lifecycle.constants";

/**
 * `reason` is a physical NOT NULL column, so the request grammar makes it a
 * required field -- there is no null spelling to carry forward.
 */
export function reason(value: JcsValue | undefined, tokens: Tokens): string {
  return requireBoundedText(requireNonemptyString(value ?? null, tokens), MAX_REASON_BYTES, tokens);
}
