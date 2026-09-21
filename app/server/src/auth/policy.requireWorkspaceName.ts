import { utf8ByteLength } from "../contracts/jcs";
import type { JcsValue } from "../contracts/jcs";
import { MAX_WORKSPACE_NAME_BYTES } from "./policy.constants";
import { reject } from "./policy.reject";

export function requireWorkspaceName(value: JcsValue): string {
  if (typeof value !== "string" || value.trim().length === 0) reject("policy_invalid");
  // No Unicode check here: the strict parser already rejects a lone surrogate
  // (including the `"\ud800"` escape form) with `invalid_unicode` before any
  // value reaches this function. A second check would be unreachable, and
  // unreachable code reads as a safeguard that is actually never exercised.
  // The cap is UTF-8 BYTES, so a multi-byte name is measured as it is stored.
  // No trimming and no case folding: the stored name is the exact match key.
  if (utf8ByteLength(value) > MAX_WORKSPACE_NAME_BYTES) reject("policy_invalid");
  return value;
}
