import type { JcsValue } from "../../contracts/jcs";
import { parseTimestamp } from "../../contracts/v1";
import { opaque } from "./opaque";
import { reject } from "./reject";

export function requireTimestampMs(value: JcsValue): number {
  if (typeof value !== "string") reject("policy_invalid");
  const parsed = opaque(() => parseTimestamp(value), "policy_invalid");
  return parsed.getTime();
}
