import type { Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";
import { name } from "./lifecycle.name";

export function nullableName(value: JcsValue | undefined, tokens: Tokens): string | null {
  return value === null || value === undefined ? null : name(value, tokens);
}
