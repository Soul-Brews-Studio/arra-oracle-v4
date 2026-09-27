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

export const MAX_TRACE_HITS_PAGE = 200;

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

// No MAX_LIFECYCLE_PAGE here (fix-round 2): the old value, 200, was unused
// and wrong -- the server's MAX_HISTORY_LIMIT is 100 and answers 200 with
// `invalid_value` at `/limit`. `useEvidenceReview` asks for 50.

export type RecallEligibility = { eligible: boolean; witness_event_id: string };

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

export type SupersedeNodeInput = {
  node_id: string;
  expected_revision_id: string;
  new_node_id: string;
  new_revision_id: string;
  reason: string;
  peer_name: string | null;
};

export type LifecycleWriteOutcome =
  | { outcome: "accepted" | "idempotent" }
  | { outcome: "conflict"; reason: string };

// Functions split out (style-ui-split2, docs/overnight/DECISIONS.md): each
// lives in its own file named after itself, re-exported here so importers
// (`state/useEvidenceReview.ts`) do not churn.
export { getTrace } from "./evidenceReview.getTrace";
export { traceOf } from "./evidenceReview.traceOf";
export { listTraceHits } from "./evidenceReview.listTraceHits";
export { hitsOf } from "./evidenceReview.hitsOf";
export { listSessionLinks } from "./evidenceReview.listSessionLinks";
export { sessionLinksOf } from "./evidenceReview.sessionLinksOf";
export { listLifecycleHistory } from "./evidenceReview.listLifecycleHistory";
export { lifecycleHistoryOf } from "./evidenceReview.lifecycleHistoryOf";
export { getRecallEligibility } from "./evidenceReview.getRecallEligibility";
export { recallEligibilityOf } from "./evidenceReview.recallEligibilityOf";
export { isSupersedeEvent } from "./evidenceReview.isSupersedeEvent";
export { getRevisionAssociations } from "./evidenceReview.getRevisionAssociations";
export { associationsOf } from "./evidenceReview.associationsOf";
export { scanDependents } from "./evidenceReview.scanDependents";
export { dependentsOf } from "./evidenceReview.dependentsOf";
export { retireNode } from "./evidenceReview.retireNode";
export { supersedeNode } from "./evidenceReview.supersedeNode";
export { lifecycleWriteOutcomeOf } from "./evidenceReview.lifecycleWriteOutcomeOf";
