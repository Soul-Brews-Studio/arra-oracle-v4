import { requireClosedObject } from "../contracts/common";
import { fail } from "../contracts/errors";
import { name } from "./search-chunk.name";
import { parseRequest } from "./search-chunk.parseRequest";

/** Bounded batch size, matching `db.ts`'s `backfill(batch = 32)` default and
 *  the same "a worker call is one bounded sweep, not a corpus walk" shape as
 *  `MAX_RECONCILE_REVISIONS`. */
export const MAX_EMBED_BATCH = 256;

const EMBED_PENDING_KEYS = ["workspace_name", "limit"] as const;

export type EmbedPendingChunksRequest = {
  workspace_name: string;
  limit: number;
};

/**
 * `limit` is required, like `reconcileSearchChunks`'s own: a caller states
 * the bound of one worker sweep rather than this kernel silently picking a
 * batch size on its behalf.
 */
export function parseEmbedPendingChunks(bytes: Uint8Array): EmbedPendingChunksRequest {
  const request = requireClosedObject(parseRequest(bytes), EMBED_PENDING_KEYS, []);
  const rawLimit = request.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_EMBED_BATCH) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_EMBED_BATCH}`);
  }
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    limit: rawLimit,
  };
}
