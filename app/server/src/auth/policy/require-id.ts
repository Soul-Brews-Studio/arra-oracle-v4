import type { JcsValue } from "../../contracts/jcs";
import { ID_PATTERN } from "./constants";
import { reject } from "./reject";

export function requireId(value: JcsValue): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) reject("policy_invalid");
  return value;
}
