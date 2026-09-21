import type { JcsValue } from "../contracts/jcs";
import { parseTimestamp } from "../contracts/v1";
import { opaque } from "./policy.opaque";
import { reject } from "./policy.reject";

export function requireTimestampMs(value: JcsValue): number {
  if (typeof value !== "string") reject("policy_invalid");
  const parsed = opaque(() => parseTimestamp(value), "policy_invalid");
  return parsed.getTime();
}
