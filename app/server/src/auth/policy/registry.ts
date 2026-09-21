import type { Policy, PolicyRecord } from "./types";

/**
 * The construction boundary. A handle only authorizes if this module minted
 * it, so JSON copies, spread clones and prototype lookalikes are rejected.
 * This is an in-process boundary, not protection against arbitrary code in
 * the process.
 *
 * MODULE-PRIVATE STATE: in the original single-file `policy.ts` this WeakMap
 * was truly file-private, touched only by `parsePolicy` (write) and `admit`
 * (read). Splitting those two into separate files means the map itself needs
 * exactly one owner module so its identity can't accidentally fork — this
 * file is that owner. The map itself is never exported; only these two
 * accessor functions cross the boundary, preserving the original
 * write-once/read-only usage pattern.
 */
const REGISTRY = new WeakMap<object, PolicyRecord>();

export function registerPolicy(handle: Policy, record: PolicyRecord): void {
  REGISTRY.set(handle, record);
}

export function lookupPolicy(handle: object): PolicyRecord | undefined {
  return REGISTRY.get(handle);
}
