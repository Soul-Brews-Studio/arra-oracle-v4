// Barrel: split into storage.storageOptions.ts and storage.storageInfo.ts
// (Nat style, one exported function per file — docs/overnight/DECISIONS.md,
// slice style-server-split, 2026-09-28). Re-exports only, so importers and
// frozen contract citations do not churn.
export { DATA_DIR, isRemote, storageOptions } from "./storage.storageOptions";
export { storageOptionsForRoot } from "./storage.storageOptionsForRoot";
export { storageInfo } from "./storage.storageInfo";
export { OPS_DIR, isOpsRootSeparate, opsStorageOptions } from "./storage.opsStorageOptions";
