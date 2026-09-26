import { failPublication } from "./errors";
import { utf8ByteLength } from "./rows";
import { NANOID21 } from "./service.constants";
import { closedKeys } from "./service.closedKeys";
import { parseRequest } from "./service.parseRequest";
import { requireNodeId } from "./service.requireNodeId";
import { requireWorkspaceName } from "./service.requireWorkspaceName";

/** Page size ceiling for listNodes, matching listMessages' MAX_PAGE_LIMIT. */
export const MAX_PAGE_LIMIT = 100;

/** Matches `taxonomy.requireName`'s own bound; a term name is stored the same way. */
const MAX_TYPE_TERM_BYTES = 256;

/**
 * K3 (overnight R18, `docs/overnight/V3-PARITY.md` §5/§7): a filter list of
 * more than this many term ids is not a realistic filter, it is a caller
 * mistake -- the same reasoning `MAX_CONTEXT_ITEMS` states for chat context.
 * Well under `MAX_SCANNED_NODES` (`service.listNodes.ts`), so a maximal
 * filter list is cheap to test per candidate row.
 */
export const MAX_FILTER_TERM_IDS = 20;

/** Exactly `rows.ts`'s `timestampToMicros` wire format, duplicated the SAME
 *  way `requireNodeId` duplicates the nanoid21 grammar here: this is a
 *  REQUEST-side check, so a malformed cursor is the caller's `invalid_request`,
 *  never the stored-row `integrity_failure` `timestampToMicros` itself would
 *  raise on the very same bytes. */
const WIRE_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

function requireWireTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length !== 24 || !WIRE_TIMESTAMP.test(value)) {
    failPublication("invalid_request", path);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) failPublication("invalid_request", path);
  return value;
}

/** K3: a nonempty, duplicate-free array of nanoid21 term ids, at most
 *  `MAX_FILTER_TERM_IDS` long. An empty array is refused rather than treated
 *  as "no filter" -- that meaning is spelled by omitting the key entirely
 *  (see each field's own doc comment below), so `[]` can only ever be a
 *  caller mistake, never a second spelling of the same thing omission means. */
function requireTermIdArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) failPublication("invalid_request", path);
  if (value.length > MAX_FILTER_TERM_IDS) failPublication("limit_exceeded", path);
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !NANOID21.test(item)) failPublication("invalid_request", path);
    if (ids.includes(item)) failPublication("invalid_request", path);
    ids.push(item);
  }
  return ids;
}

/** K4: the two orders `listNodes` supports. `id_asc` is the original,
 *  unchanged keyset order; `updated_desc` is additive (overnight R18). */
export const LIST_NODES_ORDERS = ["id_asc", "updated_desc"] as const;
export type ListNodesOrder = (typeof LIST_NODES_ORDERS)[number];

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
  /**
   * K3 (overnight R18): every term id here must be assigned on the
   * candidate's CURRENT head revision (its `term_snapshot_json`, the same
   * source `type_term`/`deriveNodeType` already read -- never a live
   * `node_revision_terms` join, which lags behind
   * `reconcileRevisionAssociations`, per `service.listNodes.ts`'s own
   * `type_term` comment). `null` omits this filter; an explicit `null` or `[]`
   * is refused (see `requireTermIdArray` above) -- the SAME "optional changes
   * only whether the key may be absent, never what it may hold once present"
   * rule `include_inactive` states. Combined with `any_term_ids` and
   * `type_term` by AND; `all_term_ids` itself is AND across its own ids.
   */
  all_term_ids: string[] | null;
  /** K3: like `all_term_ids`, but OR across its own ids (at least one must be
   *  assigned on the head revision). */
  any_term_ids: string[] | null;
  /**
   * K4 (overnight R18): optional, admitted only when sent -- omitted means
   * `"id_asc"`, the ORIGINAL keyset order, byte-identical to every caller
   * that predates this field. `"updated_desc"` orders by `nodes.updated_at`
   * descending, paired with `after_updated_at` as a keyset -- see that
   * field's own doc comment for the pairing rule.
   */
  order: ListNodesOrder;
  /**
   * K4: the second half of the `updated_desc` keyset pair, alongside
   * `after_id`. Admitted ONLY when `order` is `"updated_desc"` -- present
   * with `order: "id_asc"` (the default) is `invalid_request`, since it would
   * silently do nothing there. When `order` IS `"updated_desc"`, `after_id`
   * and this field are a PAIR: both null (the first page) or both non-null
   * (a continuation) -- one null and the other not is a half-specified
   * cursor, refused the same way. A non-null value is the exact wire-format
   * millisecond text `rows.ts`'s `timestampToMicros` accepts.
   */
  after_updated_at: string | null;
};

/** Every REQUIRED key on this request: required-but-nullable, closed exactly
 *  as before. Every OTHER key below is admitted only when the caller sends it
 *  (see each field's own doc comment above). */
const REQUIRED_KEYS = ["workspace_name", "after_id", "limit", "include_total", "type_term"] as const;
const INCLUDE_INACTIVE_KEY = "include_inactive";
const ALL_TERM_IDS_KEY = "all_term_ids";
const ANY_TERM_IDS_KEY = "any_term_ids";
const ORDER_KEY = "order";
const AFTER_UPDATED_AT_KEY = "after_updated_at";
const OPTIONAL_KEYS = [INCLUDE_INACTIVE_KEY, ALL_TERM_IDS_KEY, ANY_TERM_IDS_KEY, ORDER_KEY, AFTER_UPDATED_AT_KEY] as const;

export function parseListNodes(requestBytes: Uint8Array): ListNodesRequest {
  const o = parseRequest(requestBytes);
  const presentOptional = OPTIONAL_KEYS.filter((key) => o.has(key));
  closedKeys(o, [...REQUIRED_KEYS, ...presentOptional], "");

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

  // K3: optional, strictly typed once present -- an explicit `null` or `[]`
  // is refused by `requireTermIdArray`, the same "optional changes only
  // absence" rule `include_inactive` states above.
  let all_term_ids: string[] | null = null;
  if (o.has(ALL_TERM_IDS_KEY)) all_term_ids = requireTermIdArray(o.get(ALL_TERM_IDS_KEY), `/${ALL_TERM_IDS_KEY}`);
  let any_term_ids: string[] | null = null;
  if (o.has(ANY_TERM_IDS_KEY)) any_term_ids = requireTermIdArray(o.get(ANY_TERM_IDS_KEY), `/${ANY_TERM_IDS_KEY}`);

  // K4: optional; absent means the original "id_asc" order.
  let order: ListNodesOrder = "id_asc";
  if (o.has(ORDER_KEY)) {
    const rawOrder = o.get(ORDER_KEY);
    if (rawOrder !== "id_asc" && rawOrder !== "updated_desc") failPublication("invalid_request", `/${ORDER_KEY}`);
    order = rawOrder;
  }

  // K4: `after_updated_at` only means anything paired with `order:
  // "updated_desc"` -- present under the default order is refused rather than
  // silently ignored (this file refuses every argument that would otherwise
  // do nothing, e.g. `include_inactive: null`).
  let after_updated_at: string | null = null;
  if (o.has(AFTER_UPDATED_AT_KEY)) {
    if (order !== "updated_desc") failPublication("invalid_request", `/${AFTER_UPDATED_AT_KEY}`);
    const rawAfterUpdatedAt = o.get(AFTER_UPDATED_AT_KEY);
    after_updated_at =
      rawAfterUpdatedAt === null || rawAfterUpdatedAt === undefined
        ? null
        : requireWireTimestamp(rawAfterUpdatedAt, `/${AFTER_UPDATED_AT_KEY}`);
  }
  // The two halves of the `updated_desc` keyset pair travel together: a page
  // boundary is either "the very first page" (both null) or "resume exactly
  // here" (both non-null). One set and the other not is a cursor missing
  // half of itself, not a value this kernel can interpret one way or another.
  if (order === "updated_desc" && (after_id === null) !== (after_updated_at === null)) {
    failPublication("invalid_request", `/${AFTER_UPDATED_AT_KEY}`);
  }

  return {
    workspace_name,
    after_id,
    limit: rawLimit,
    include_total: rawIncludeTotal,
    type_term,
    include_inactive,
    all_term_ids,
    any_term_ids,
    order,
    after_updated_at,
  };
}
