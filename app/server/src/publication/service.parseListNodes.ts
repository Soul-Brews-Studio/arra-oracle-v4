import { failPublication } from "./errors";
import { utf8ByteLength } from "./rows";
import { closedKeys } from "./service.closedKeys";
import { parseRequest } from "./service.parseRequest";
import { requireNodeId } from "./service.requireNodeId";
import { requireWorkspaceName } from "./service.requireWorkspaceName";

/** Page size ceiling for listNodes, matching listMessages' MAX_PAGE_LIMIT. */
export const MAX_PAGE_LIMIT = 100;

/** Matches `taxonomy.requireName`'s own bound; a term name is stored the same way. */
const MAX_TYPE_TERM_BYTES = 256;

export type ListNodesRequest = {
  workspace_name: string;
  /** Keyset cursor: nullable nanoid21. A page starts STRICTLY after this id. */
  after_id: string | null;
  limit: number;
  /**
   * Opt-in workspace-scoped total. Every other field on this request is
   * required-but-nullable (never omittable) to match this codebase's closed-
   * key discipline everywhere else -- `include_total` follows the SAME rule:
   * a caller states `false` explicitly rather than relying on an absent key
   * to mean it, so there is never a request where "did they forget it" and
   * "they didn't want it" look identical on the wire.
   */
  include_total: boolean;
  /** Nullable term NAME from the reserved `type` vocabulary (e.g. "conclusion"). */
  type_term: string | null;
};

export function parseListNodes(requestBytes: Uint8Array): ListNodesRequest {
  const o = parseRequest(requestBytes);
  closedKeys(o, ["workspace_name", "after_id", "limit", "include_total", "type_term"], "");

  const workspace_name = requireWorkspaceName(o.get("workspace_name"), "/workspace_name");

  const rawAfter = o.get("after_id");
  const after_id = rawAfter === null || rawAfter === undefined ? null : requireNodeId(rawAfter, "/after_id");

  const rawLimit = o.get("limit");
  // A small JSON integer, deliberately: the page size is not an Int64 wire
  // field, so a decimal string here is a type error rather than a cursor.
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) failPublication("invalid_request", "/limit");
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) failPublication("invalid_request", "/limit");

  const rawIncludeTotal = o.get("include_total");
  if (typeof rawIncludeTotal !== "boolean") failPublication("invalid_request", "/include_total");

  const rawTypeTerm = o.get("type_term");
  let type_term: string | null = null;
  if (rawTypeTerm !== null && rawTypeTerm !== undefined) {
    if (typeof rawTypeTerm !== "string" || rawTypeTerm.length === 0) failPublication("invalid_request", "/type_term");
    if (utf8ByteLength(rawTypeTerm) > MAX_TYPE_TERM_BYTES) failPublication("invalid_request", "/type_term");
    type_term = rawTypeTerm;
  }

  return { workspace_name, after_id, limit: rawLimit, include_total: rawIncludeTotal, type_term };
}
