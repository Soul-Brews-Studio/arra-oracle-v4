import { requireNanoid21, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";

/** The declared namespace for node and revision ids is nanoid21. */
export function nanoidField(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNanoid21(value ?? null, tokens);
}
