/** Typed wrappers for the #33 "evidence review" surface: traces, session
 *  links and node lifecycle. All five methods here are `content:read` (see
 *  `knowledge/registry.ts`), so this file only reads -- creating a trace or
 *  a session link, or superseding/retiring a node, stays out of this UI's
 *  scope tonight (R7/R8 expose the writes; wiring their forms is not part
 *  of this issue's four surfaces).
 *
 * Three DIFFERENT scopes, not one "evidence" key, because the kernels
 * disagree about what identifies a row:
 *   - a trace is looked up by ITS OWN id (`getTrace`/`listTraceHits`) --
 *     there is no `listTraces`, so a caller must already hold the id, the
 *     same "no enumeration" property `api/knowledge.ts` documents for nodes.
 *   - a session link is looked up by `session_name` (`listSessionLinks`).
 *   - lifecycle history and recall eligibility are looked up by `node_id`.
 * `EvidenceReviewPanel`'s three sections each take the identifier they
 * actually need, rather than a single "evidence for X" prop that would
 * imply one of the three is authoritative over the others.
 */
import { type ApiResult, callMethod } from "./client";
import { type Bank } from "./memory";

const call = (b: Bank, method: string, body: Record<string, unknown>): Promise<ApiResult> =>
  callMethod(b.bank, method, { workspace_name: b.workspace, ...body }, b.token);

/** `trace.encodeTraceRow.ts` TRACE_FIELDS, wire order. */
export type TraceRow = {
  id: string;
  name: string;
  workspace_name: string;
  session_name: string | null;
  peer_name: string | null;
  query: string;
  mode: string | null;
  session_id: string | null;
  session_from_ts: string | null;
  session_to_ts: string | null;
  friction_score: number | null;
  confidence: string | null;
  parent_id: string | null;
  prev_id: string | null;
  depth: string;
  status: "open" | "complete" | "abandoned";
  h_metadata: string | null;
  internal_metadata: string | null;
  created_at: string;
  updated_at: string;
};

/** `trace.encodeTraceHitRow.ts` TRACE_HIT_FIELDS. No `id` column -- a hit's
 *  key is `(workspace_name, trace_id, position)`. `target` is the stored
 *  canonical `{target_kind, target}` JSON TEXT, shown raw rather than
 *  re-parsed into an invented shape. */
export type TraceHitRow = {
  workspace_name: string;
  trace_id: string;
  kind: string;
  ref: string;
  target: string;
  line_start: string | null;
  line_end: string | null;
  excerpt: string | null;
  content_hash: string | null;
  captured_at: string | null;
  note: string | null;
  position: string;
};

export const getTrace = (b: Bank, id: string) => call(b, "getTrace", { id });

/** `service.getTrace.ts` returns the stored row directly (or `null`), NOT a
 *  `{trace: ...}` wrapper -- verified against the kernel, the same "read the
 *  actual envelope key, not the analogous-looking one" trap `api/listing.ts`
 *  hit for `listPeers`. `null` is an ANSWER ("no such trace"), the same
 *  "null is not an error" contract `getAcceptedHead` uses. */
export function traceOf(result: ApiResult): TraceRow | null {
  if (!result.ok) return null;
  return (result.body as TraceRow | null) ?? null;
}

export const MAX_TRACE_HITS_PAGE = 200;

export const listTraceHits = (b: Bank, trace_id: string, after_position: string | null, limit: number) =>
  call(b, "listTraceHits", { trace_id, after_position, limit });

export function hitsOf(result: ApiResult): { rows: TraceHitRow[]; nextAfterPosition: string | null } {
  if (!result.ok) return { rows: [], nextAfterPosition: null };
  const body = result.body as { rows?: TraceHitRow[]; next_after_position?: string | null } | null;
  return {
    rows: Array.isArray(body?.rows) ? (body!.rows as TraceHitRow[]) : [],
    nextAfterPosition: typeof body?.next_after_position === "string" ? body.next_after_position : null,
  };
}

/** `session-link.ts` SESSION_LINK_FIELDS, wire order. */
export type SessionLinkRow = {
  id: string;
  workspace_name: string;
  from_session_name: string;
  to_session_name: string;
  relation: "continues" | "forked_from" | "related_to";
  evidence_ref: string | null;
  created_by_peer_name: string | null;
  created_at: string;
};

export const MAX_SESSION_LINKS_PAGE = 100;

/** `direction: "from"` finds links this session STARTS (`from_session_name`
 *  = the argument); `"to"` finds links that point AT it. Both directions
 *  matter for evidence review: a session can be evidence FOR another
 *  session's link, not only the other way round. */
export const listSessionLinks = (
  b: Bank,
  session_name: string,
  direction: "from" | "to",
  cursor: string | null,
  limit: number,
) => call(b, "listSessionLinks", { session_name, direction, cursor, limit });

export function sessionLinksOf(result: ApiResult): { rows: SessionLinkRow[]; nextCursor: string | null } {
  if (!result.ok) return { rows: [], nextCursor: null };
  const body = result.body as { rows?: SessionLinkRow[]; next_cursor?: string | null } | null;
  return {
    rows: Array.isArray(body?.rows) ? (body!.rows as SessionLinkRow[]) : [],
    nextCursor: typeof body?.next_cursor === "string" ? body.next_cursor : null,
  };
}

/** `lifecycle.ts`'s `encodeSupersedeLogRow` shape: `new_id`/`new_revision_id`
 *  BOTH non-null is a supersede event, both null is a retirement -- there is
 *  no separate event-kind column (see `isSupersedeEvent`). */
export type LifecycleEventRow = {
  id: string;
  workspace_name: string;
  old_id: string;
  old_revision_id: string;
  old_title: string | null;
  old_type: string | null;
  new_id: string | null;
  new_revision_id: string | null;
  new_title: string | null;
  reason: string;
  peer_name: string | null;
  superseded_at: string;
  operation_id: string;
  h_metadata: string | null;
};

export const isSupersedeEvent = (row: LifecycleEventRow): boolean => row.new_id !== null;

export const MAX_LIFECYCLE_PAGE = 200;

export const listLifecycleHistory = (b: Bank, node_id: string, after_event_id: string | null, limit: number) =>
  call(b, "listLifecycleHistory", { node_id, after_event_id, limit });

export function lifecycleHistoryOf(result: ApiResult): {
  rows: LifecycleEventRow[];
  nextAfterEventId: string | null;
} {
  if (!result.ok) return { rows: [], nextAfterEventId: null };
  const body = result.body as { rows?: LifecycleEventRow[]; next_after_event_id?: string | null } | null;
  return {
    rows: Array.isArray(body?.rows) ? (body!.rows as LifecycleEventRow[]) : [],
    nextAfterEventId: typeof body?.next_after_event_id === "string" ? body.next_after_event_id : null,
  };
}

export type RecallEligibility = { eligible: boolean; witness_event_id: string };

export const getRecallEligibility = (b: Bank, node_id: string) => call(b, "getRecallEligibility", { node_id });

export function recallEligibilityOf(result: ApiResult): RecallEligibility | null {
  if (!result.ok) return null;
  const body = result.body as Partial<RecallEligibility> | null;
  if (typeof body?.eligible !== "boolean" || typeof body?.witness_event_id !== "string") return null;
  return { eligible: body.eligible, witness_event_id: body.witness_event_id };
}
