import { requireClosedObject, type Tokens } from "../contracts/common";
import type { JcsObject, JcsValue } from "../contracts/jcs";
import { opaque } from "./policy.opaque";

const NO_TOKENS: Tokens = [];

export function closed(value: JcsValue, keys: readonly string[]): JcsObject {
  return opaque(() => requireClosedObject(value, keys, NO_TOKENS), "policy_invalid");
}
