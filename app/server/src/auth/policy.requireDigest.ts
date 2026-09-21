import type { JcsValue } from "../contracts/jcs";
import { SHA256_HEX } from "./policy.constants";
import { reject } from "./policy.reject";

export function requireDigest(value: JcsValue): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) reject("policy_invalid");
  return value;
}
