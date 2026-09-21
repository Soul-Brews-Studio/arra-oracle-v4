import type { Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";
import { name } from "./context.name";

/** `after_name` cursor variant of `name`: JSON null passes through unchanged
 *  (no cursor yet); anything else is validated as an ordinary name. */
export function nullableName(value: JcsValue | undefined, tokens: Tokens): string | null {
  return value === null ? null : name(value, tokens);
}
