// Where the operations tables (`mcp_calls`, `connections`, `instance_audit`)
// live (R33 S4(a), Nat 2026-09-28, docs/overnight/DECISIONS.md).
//
// `ARRA_OPS_DIR` is read once at import, same idiom as `ARRA_DATA_DIR`
// (`storage.storageOptions.ts`). When unset, ops tables keep living in
// `ARRA_DATA_DIR` -- EXACT current behaviour, so an unset env var changes
// nothing. When set, the three openers below resolve to it instead, and
// `ARRA_DATA_DIR` no longer holds ops tables at all.

import { DATA_DIR, storageOptionsForRoot } from "./storage.storageOptions";

export const OPS_DIR = process.env.ARRA_OPS_DIR ?? DATA_DIR;
export const isOpsRootSeparate = process.env.ARRA_OPS_DIR !== undefined;

export function opsStorageOptions(): Record<string, string> | undefined {
  return storageOptionsForRoot(OPS_DIR);
}
