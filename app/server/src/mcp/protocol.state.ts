// Split from protocol.ts (style-split4b, 2026-09-28): data-only module identity for
// this wire's shared constants and types. No functions here -- see protocol.<fn>.ts.

/** Revisions we know how to speak. Anything else still gets an answer — in the
 *  newest of these — rather than silence. Kept in sync with digger-node. */
export const KNOWN_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const SERVER_NAME = "arra-oracle-v4";
export const SERVER_VERSION = "26.9.28-alpha.638";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}
