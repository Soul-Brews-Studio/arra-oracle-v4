import type { JcsValue } from "../contracts/jcs";
import { reject } from "./policy.reject";

export function requireArrayValue(value: JcsValue): JcsValue[] {
  if (!Array.isArray(value)) reject("policy_invalid");
  return value;
}
