import type { JcsValue } from "../jcs";
import type { Tokens } from "../common";

export function requireNullable<T>(value: JcsValue, tokens: Tokens, read: (v: JcsValue, t: Tokens) => T): T | null {
  return value === null ? null : read(value, tokens);
}
