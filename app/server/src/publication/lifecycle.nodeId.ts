import { requireNanoid21, type Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";

/** The declared node/revision namespace: nanoid21, statically. */
export function nodeId(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNanoid21(value ?? null, tokens);
}
