import { requireClosedObject } from "../contracts/common";
import { fail } from "../contracts/errors";
import { utf8ByteLength } from "./rows";
import { parseRequest } from "./taxonomy.parseRequest";
import { requireId } from "./taxonomy.requireId";
import { requireWorkspace } from "./taxonomy.requireWorkspace";

/** V3-PARITY.md §5 K6: `listTermUsage {vocabulary_id, type_term|null, limit≤200}`. */
export const MAX_TERM_USAGE_LIMIT = 200;

/** Matches `taxonomy.requireName`'s own bound; a type term name is stored the same way. */
const MAX_TYPE_TERM_BYTES = 256;

export type ListTermUsageRequest = {
  workspace_name: string;
  vocabulary_id: string;
  /** Nullable term NAME from the reserved `type` vocabulary, e.g. "learning". */
  type_term: string | null;
  limit: number;
};

/**
 * K6 (docs/overnight/V3-PARITY.md §5): how many CURRENT heads reference each
 * term of one vocabulary -- `oracle_concepts`' (#31 V8) real capability.
 * Counted from each accepted head's own `term_snapshot_json`, never from the
 * derived `node_revision_terms` projection, which lags every writer that
 * does not reconcile (see `service.listTermUsage.ts` for the second fix
 * round that moved it). `coverage` discloses it honestly when the bounded
 * node scan cannot see the whole workspace.
 */
export function parseListTermUsage(bytes: Uint8Array): ListTermUsageRequest {
  const request = requireClosedObject(
    parseRequest(bytes),
    ["workspace_name", "vocabulary_id", "type_term", "limit"],
    [],
  );

  const rawTypeTerm = request.get("type_term");
  let type_term: string | null = null;
  if (rawTypeTerm !== null) {
    if (typeof rawTypeTerm !== "string" || rawTypeTerm.length === 0) fail("invalid_value", ["type_term"], "expected a nonempty string or null");
    if (utf8ByteLength(rawTypeTerm) > MAX_TYPE_TERM_BYTES) fail("limit_exceeded", ["type_term"], `expected at most ${MAX_TYPE_TERM_BYTES} bytes`);
    type_term = rawTypeTerm;
  }

  const rawLimit = request.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) fail("invalid_type", ["limit"], "expected integer");
  if (rawLimit < 1 || rawLimit > MAX_TERM_USAGE_LIMIT) fail("invalid_value", ["limit"], `expected 1..${MAX_TERM_USAGE_LIMIT}`);

  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    vocabulary_id: requireId(request.get("vocabulary_id"), ["vocabulary_id"]),
    type_term,
    limit: rawLimit,
  };
}
