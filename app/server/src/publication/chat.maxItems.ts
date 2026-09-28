// Split from chat.ts (style-split4b, 2026-09-28).
import { fail } from "../contracts/errors";
import type { JcsValue } from "../contracts/jcs";
import type { Tokens } from "../contracts/common";
import { MAX_CONTEXT_ITEMS } from "./chat.state";

/** A small JSON integer, deliberately: this bounds a compose-time count, not
 *  an Int64 wire field. */
export function maxItems(value: JcsValue | undefined, tokens: Tokens): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail("invalid_type", tokens, "expected integer");
  }
  if (value < 1 || value > MAX_CONTEXT_ITEMS) {
    fail("invalid_value", tokens, `expected 1..${MAX_CONTEXT_ITEMS}`);
  }
  return value;
}
