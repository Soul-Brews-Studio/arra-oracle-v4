import { requireNanoid21, type Tokens } from "../../contracts/common";
import type { JcsValue } from "../../contracts/jcs";

export function requireId(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNanoid21(value ?? null, tokens);
}
