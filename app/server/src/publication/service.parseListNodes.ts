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
  /**
   * #29 slice B (overnight R7), amended in the fix round: the ONE optional
   * key on this request -- every other field here is required-but-nullable,
   * but a required `include_inactive` broke the in-repo daily-loop alias
   * (`app/cli/kb.aliases.ts`'s `nodes list`, documented at `app/README.md`'s
   * `bun app/cli.ts nodes list --bank example --limit 20`) and any other
   * caller built against the pre-#29 grammar, none of which ever sent this
   * key. Omitted means `false`, the ordinary "current" view -- the SAME
   * default the ruling always intended (`docs/overnight/DECISIONS.md` R7:
   * "`listNodes` excludes retired and superseded nodes by default"), just
   * expressed as a key default instead of a required key with no default.
   * `true` is history mode. Still closed-TYPED when present: an explicit
   * `include_inactive: null` is refused `invalid_request`, exactly like
   * `include_total`'s boolean -- "optional" only changes whether the key may
   * be ABSENT, never what it may hold once present. See `service.listNodes.ts`
   * for the exact filter and `lifecycle-v1.md`'s amendment for why
   * `is_active`/the validity window are NOT part of this filter (only
   * DESIGN.md §9's "replaced or retired" predicate is).
   */
  include_inactive: boolean;
};

/** Every OTHER key on this request: required-but-nullable, closed exactly as
 *  before. `include_inactive` alone is admitted only when the caller sends it
 *  (see the field's own doc comment above). */
const REQUIRED_KEYS = ["workspace_name", "after_id", "limit", "include_total", "type_term"] as const;
const INCLUDE_INACTIVE_KEY = "include_inactive";

export function parseListNodes(requestBytes: Uint8Array): ListNodesRequest {
  const o = parseRequest(requestBytes);
  closedKeys(o, o.has(INCLUDE_INACTIVE_KEY) ? [...REQUIRED_KEYS, INCLUDE_INACTIVE_KEY] : REQUIRED_KEYS, "");

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

  // Optional: absent means false (see the field's doc comment above). Present
  // means strictly boolean -- `null` is a type error, not a spelling of
  // "absent"; the closed-key check above already guarantees "present" here
  // means the caller actually sent the key.
  let include_inactive = false;
  if (o.has(INCLUDE_INACTIVE_KEY)) {
    const rawIncludeInactive = o.get(INCLUDE_INACTIVE_KEY);
    if (typeof rawIncludeInactive !== "boolean") failPublication("invalid_request", "/include_inactive");
    include_inactive = rawIncludeInactive;
  }

  const rawTypeTerm = o.get("type_term");
  let type_term: string | null = null;
  if (rawTypeTerm !== null && rawTypeTerm !== undefined) {
    if (typeof rawTypeTerm !== "string" || rawTypeTerm.length === 0) failPublication("invalid_request", "/type_term");
    if (utf8ByteLength(rawTypeTerm) > MAX_TYPE_TERM_BYTES) failPublication("invalid_request", "/type_term");
    type_term = rawTypeTerm;
  }

  return {
    workspace_name,
    after_id,
    limit: rawLimit,
    include_total: rawIncludeTotal,
    type_term,
    include_inactive,
  };
}
