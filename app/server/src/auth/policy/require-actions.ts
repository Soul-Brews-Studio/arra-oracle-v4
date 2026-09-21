import type { JcsValue } from "../../contracts/jcs";
import { requireArrayValue } from "./require-array-value";
import { reject } from "./reject";

export function requireActions<T extends string>(value: JcsValue, allowed: readonly T[]): T[] {
  const raw = requireArrayValue(value);
  const actions: T[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !(allowed as readonly string[]).includes(entry)) {
      reject("policy_invalid");
    }
    actions.push(entry as T);
  }
  return actions;
}
