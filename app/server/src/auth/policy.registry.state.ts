import type { PolicyRecord } from "./policy.types";

/**
 * The construction boundary. A handle only authorizes if this module minted
 * it, so JSON copies, spread clones and prototype lookalikes are rejected.
 * This is an in-process boundary, not protection against arbitrary code in
 * the process.
 *
 * MODULE-PRIVATE STATE: in the original single-file `policy.ts` this WeakMap
 * was truly file-private, touched only by `parsePolicy` (write) and `admit`
 * (read). Splitting registerPolicy/lookupPolicy into their own files still
 * needs exactly one owner module for the map itself so its identity can't
 * accidentally fork -- this file is that owner. REGISTRY is exported only
 * for its two sibling accessor files (registerPolicy.ts, lookupPolicy.ts) to
 * import directly; it is not re-exported through the policy.registry.ts
 * barrel and must never be imported from outside this directory.
 */
export const REGISTRY = new WeakMap<object, PolicyRecord>();
