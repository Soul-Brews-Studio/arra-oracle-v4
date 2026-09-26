/** Typed wrappers for the #33 "evidence review" surface: traces, session
 *  links, node lifecycle, and (fix-round R12) the direct/reverse revision
 *  evidence lists and the two lifecycle WRITES.
 *
 * Fix round: brief item (4) named `supersedeNode`/`retireNode` and
 * `getRevisionAssociations`/`scanDependents` explicitly -- all four exist in
 * `registry.ts` on this base -- and the previous pass left every one of them
 * unwired. This file now covers all four plus their two reads. Creating a
 * TRACE or a SESSION LINK stays out of this UI's scope (the issue's four
 * surfaces do not ask for authoring evidence, only reviewing it), which is
 * why `createTrace`/`createSessionLink` still have no wrapper here.
 *
 * FIVE different scopes, not one "evidence" key, because the kernels
 * disagree about what identifies a row:
 *   - a trace is looked up by ITS OWN id (`getTrace`/`listTraceHits`) --
 *     there is no `listTraces`, so a caller must already hold the id, the
 *     same "no enumeration" property `api/knowledge.ts` documents for nodes.
 *   - a session link is looked up by `session_name` (`listSessionLinks`).
 *   - lifecycle history and recall eligibility are looked up by `node_id`.
 *   - direct evidence (`getRevisionAssociations`) is looked up by
 *     `(node_id, revision_id)`, `revision_id: null` meaning the captured
 *     head (`association-evidence-v1.md` §2).
 *   - reverse evidence (`scanDependents`) is looked up by a TARGET, not a
 *     node: this file only ever builds a `node_revision` target (the exact
 *     `(node_id, revision_id)` `getRevisionAssociations` just resolved), so
 *     "who cites this revision" and "what does this revision cite" describe
 *     the SAME resolved identity from two directions.
 * `EvidenceReviewPanel`'s sections each take the identifier they actually
 * need, rather than a single "evidence for X" prop that would imply one of
 * them is authoritative over the others.
 */
import { type ApiResult, callMethod } from "./client";
import { type Bank, newPublicId } from "./memory";

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

// No MAX_LIFECYCLE_PAGE here (fix-round 2): the old value, 200, was unused
// and wrong -- the server's MAX_HISTORY_LIMIT is 100 and answers 200 with
// `invalid_value` at `/limit`. `useEvidenceReview` asks for 50.

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

// ── direct evidence: what THIS revision cites (#33 R12) ─────────────────────
// `association-evidence-v1.md` §3's exact physical wire field order.
export type AssociationTermRow = {
  workspace_name: string;
  revision_id: string;
  term_id: string;
  vocabulary_id: string;
  vocabulary_name_snapshot: string;
  term_name_snapshot: string;
  label_snapshot: string | null;
  position: string;
};

export type AssociationLinkRow = {
  workspace_name: string;
  revision_id: string;
  position: string;
  relation: string;
  target_kind: string;
  target: string;
  target_key: string;
  excerpt: string | null;
  content_hash: string | null;
  captured_at: string | null;
  capture_status: string;
  note: string | null;
};

export type AssociationResult = {
  workspace_name: string;
  node_id: string;
  revision_id: string;
  content_digest: string;
  snapshot_head_revision_id: string;
  is_snapshot_head: boolean;
  terms: AssociationTermRow[];
  links: AssociationLinkRow[];
};

/** `revision_id: null` means the CAPTURED HEAD (`association-evidence-v1.md`
 *  §2) -- distinct from omitting the key, so this always sends the key,
 *  explicitly null when no exact revision was picked. */
export const getRevisionAssociations = (b: Bank, node_id: string, revision_id: string | null) =>
  call(b, "getRevisionAssociations", { node_id, revision_id });

/** The kernel answers a bare `null` for "no such node/revision on accepted
 *  ancestry" -- an ANSWER, the same "null is not an error" contract
 *  `getAcceptedHead`/`getTrace` use, not a shape to reject. */
export function associationsOf(result: ApiResult): AssociationResult | null {
  if (!result.ok) return null;
  return (result.body as AssociationResult | null) ?? null;
}

// ── reverse evidence: who cites THIS revision (#33 R12) ─────────────────────
// This file only ever targets `node_revision` (`contracts/evidence-v1.ts`
// TARGET_KEYS), because the identity being asked about is always the exact
// `(node_id, revision_id)` `getRevisionAssociations` just resolved -- never a
// raw caller-typed key (the contract forbids that: "No raw caller-supplied
// target key").
export type NodeRevisionTarget = { node_id: string; revision_id: string };

/** Opaque to this client: the exact shape is `association-evidence-v1.md`
 *  §4's closed cursor object, but nothing here reads its fields -- it is
 *  only ever round-tripped, unchanged, from a page's `next_cursor` back into
 *  the next request's `cursor`, per the contract's "Cursor fields are
 *  request data" rule. */
export type DependentsCursor = Record<string, unknown>;

export type DependentOccurrence = {
  workspace_name: string;
  node_id: string;
  revision_id: string;
  revision_no: string;
  content_digest: string;
  snapshot_head_revision_id: string;
  is_snapshot_head: boolean;
  link: AssociationLinkRow;
};

export const MAX_DEPENDENTS_PAGE = 100;

/** `revision_mode: "current"` -- dependents scoped to what OTHER nodes'
 *  captured heads cite right now, matching how `getRecallEligibility` and
 *  the rest of this review surface already read "current" state rather than
 *  full history. `"history"` exists in the kernel but is not exposed here:
 *  the brief asks for direct/reverse evidence, not a history-mode toggle. */
export const scanDependents = (
  b: Bank,
  target: NodeRevisionTarget,
  limit: number,
  cursor: DependentsCursor | null,
) =>
  call(b, "scanDependents", {
    target_kind: "node_revision",
    target,
    revision_mode: "current",
    limit,
    cursor,
  });

export function dependentsOf(result: ApiResult): {
  outcome: "page" | "restart_required" | "error";
  occurrences: DependentOccurrence[];
  nextCursor: DependentsCursor | null;
} {
  if (!result.ok) return { outcome: "error", occurrences: [], nextCursor: null };
  const body = result.body as
    | { outcome?: string; occurrences?: DependentOccurrence[]; next_cursor?: DependentsCursor | null }
    | null;
  if (body?.outcome === "restart_required") return { outcome: "restart_required", occurrences: [], nextCursor: null };
  return {
    outcome: "page",
    occurrences: Array.isArray(body?.occurrences) ? (body!.occurrences as DependentOccurrence[]) : [],
    nextCursor: body?.next_cursor ?? null,
  };
}

// ── lifecycle writes: retire / supersede (#29, #33 R12) ──────────────────────
// Both are `content:write` (`registry.ts`), reached the same way every other
// write in this app is: the same bank/token `callMethod` already carries --
// there is no separate client-side "writer gate" concept, the server enforces
// that. `operation_id` is minted the same way `publishRevision` mints one:
// caller-owned, reused only on an intentional retry.
export type RetireNodeInput = {
  node_id: string;
  expected_revision_id: string;
  reason: string;
  peer_name: string | null;
};

export const retireNode = (b: Bank, input: RetireNodeInput) =>
  call(b, "retireNode", { ...input, operation_id: newPublicId() });

export type SupersedeNodeInput = {
  node_id: string;
  expected_revision_id: string;
  new_node_id: string;
  new_revision_id: string;
  reason: string;
  peer_name: string | null;
};

export const supersedeNode = (b: Bank, input: SupersedeNodeInput) =>
  call(b, "supersedeNode", { ...input, operation_id: newPublicId() });

export type LifecycleWriteOutcome =
  | { outcome: "accepted" | "idempotent" }
  | { outcome: "conflict"; reason: string };

/** `service.writeLifecycleEvent.ts`'s three outcomes. The stored `row` is
 *  intentionally NOT surfaced here: the caller already knows what it asked
 *  for, and a fresh `listLifecycleHistory`/`getRecallEligibility` refetch
 *  (which every caller of this does) is the authoritative post-write read,
 *  not a second, divergent shape carried on the write response. */
export function lifecycleWriteOutcomeOf(result: ApiResult): LifecycleWriteOutcome | null {
  if (!result.ok) return null;
  const body = result.body as { outcome?: string; reason?: string } | null;
  if (body?.outcome === "accepted" || body?.outcome === "idempotent") return { outcome: body.outcome };
  if (body?.outcome === "conflict" && typeof body.reason === "string") {
    return { outcome: "conflict", reason: body.reason };
  }
  return null;
}
