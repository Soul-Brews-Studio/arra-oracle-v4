import type { PolicyRecord } from "./policy.types";
import { REGISTRY } from "./policy.registry.state";

export function lookupPolicy(handle: object): PolicyRecord | undefined {
  return REGISTRY.get(handle);
}
