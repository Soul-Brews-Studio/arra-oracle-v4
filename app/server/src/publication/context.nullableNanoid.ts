import type { Tokens } from "../contracts/common";
import type { JcsValue } from "../contracts/jcs";
import { nanoid } from "./context.nanoid";

export function nullableNanoid(value: JcsValue | undefined, tokens: Tokens): string | null {
  return value === null ? null : nanoid(value, tokens);
}
