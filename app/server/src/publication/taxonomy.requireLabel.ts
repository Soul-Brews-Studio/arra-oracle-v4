import { requireNonemptyString, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";

/** A display label is nonempty, and also carries NO 256-byte cap. */
export function requireLabel(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNonemptyString(value ?? null, tokens);
}
