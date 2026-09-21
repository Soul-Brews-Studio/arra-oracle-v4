import type { Tokens } from "../../contracts/common";
import type { JcsValue } from "../../contracts/jcs";
import { requireId } from "./require-id";

export function requireNullableId(value: JcsValue | undefined, tokens: Tokens): string | null {
  return value === null ? null : requireId(value, tokens);
}
