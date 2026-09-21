import type { JcsValue } from "../../contracts/jcs";
import { reject } from "./reject";

export function requireBooleanValue(value: JcsValue): boolean {
  if (typeof value !== "boolean") reject("policy_invalid");
  return value;
}
