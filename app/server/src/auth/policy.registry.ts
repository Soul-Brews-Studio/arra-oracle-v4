// Re-export barrel: kept at the original path so importers and frozen
// contract citations do not churn. Split into policy.registry.registerPolicy.ts
// and policy.registry.lookupPolicy.ts (Nat style: one exported function per
// file, named after the file -- docs/overnight/DECISIONS.md). The two split
// files import the shared WeakMap directly from policy.registry.state.ts,
// never through this barrel.
export { registerPolicy } from "./policy.registry.registerPolicy";
export { lookupPolicy } from "./policy.registry.lookupPolicy";
