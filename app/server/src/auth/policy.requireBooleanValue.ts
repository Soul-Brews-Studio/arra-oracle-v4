import type { JcsValue } from "../contracts/jcs";
import { reject } from "./policy.reject";

export function requireBooleanValue(value: JcsValue): boolean {
  if (typeof value !== "boolean") reject("policy_invalid");
  return value;
}
