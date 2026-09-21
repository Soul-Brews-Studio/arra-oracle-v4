import { requireClosedObject } from "../contracts/common";
import { fail } from "../contracts/errors";
import { name } from "./search-chunk.name";
import { parseRequest } from "./search-chunk.parseRequest";

/** Bounded sweep limit for reconciliation. See `parseReconcileSearch`. */
export const MAX_RECONCILE_REVISIONS = 1024;

const RECONCILE_KEYS = ["workspace_name", "limit"] as const;

export type ReconcileSearchChunksRequest = {
  workspace_name: string;
  limit: number;
};

/**
 * `limit` bounds a single bounded sweep. It is a small JSON integer, not an
 * Int64 wire field, deliberately capped at `MAX_RECONCILE_REVISIONS`: a
 * caller cannot ask this kernel to visit more than the bounded exception
 * documented on the reconcile writer permits.
 */
export function parseReconcileSearch(bytes: Uint8Array): ReconcileSearchChunksRequest {
  const request = requireClosedObject(parseRequest(bytes), RECONCILE_KEYS, []);
  const rawLimit = request.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_RECONCILE_REVISIONS) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_RECONCILE_REVISIONS}`);
  }
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    limit: rawLimit,
  };
}
