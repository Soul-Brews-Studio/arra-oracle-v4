import type { Policy, PolicyRecord } from "./policy.types";
import { REGISTRY } from "./policy.registry.state";

export function registerPolicy(handle: Policy, record: PolicyRecord): void {
  REGISTRY.set(handle, record);
}
