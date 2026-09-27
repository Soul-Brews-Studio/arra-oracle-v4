/**
 * Shared constants, key lists and request/row types for the lifecycle.*
 * split files. No exported functions here (values and types only), so this
 * file sits outside the one-exported-function-per-file ratchet by
 * construction -- it exists purely so the split files never duplicate a
 * literal.
 */

export const MAX_REQUEST_BYTES = 1048576;
export const MAX_REQUEST_DEPTH = 64;
export const MAX_NAME_BYTES = 256;
/** No physical bound is declared for `reason`; this is a CHOSEN wire cap for
 *  this grammar, not a schema fact. */
export const MAX_REASON_BYTES = 4096;
/** Page size ceiling for listLifecycleHistory. A small JSON integer, NOT an
 *  Int64 wire field. */
export const MAX_HISTORY_LIMIT = 100;

export const SUPERSEDE_KEYS = [
  "workspace_name",
  "node_id",
  "expected_revision_id",
  "new_node_id",
  "new_revision_id",
  "reason",
  "peer_name",
  "operation_id",
] as const;
export const RETIRE_KEYS = [
  "workspace_name",
  "node_id",
  "expected_revision_id",
  "reason",
  "peer_name",
  "operation_id",
] as const;
export const ELIGIBILITY_KEYS = ["workspace_name", "node_id"] as const;
export const HISTORY_KEYS = ["workspace_name", "node_id", "after_event_id", "limit"] as const;

/** EXACTLY these 16 columns, in physical order. */
export const SUPERSEDE_LOG_FIELDS = [
  "id",
  "workspace_name",
  "old_id",
  "old_revision_id",
  "old_title",
  "old_type",
  "old_source",
  "new_id",
  "new_revision_id",
  "new_title",
  "new_source",
  "reason",
  "peer_name",
  "superseded_at",
  "operation_id",
  "h_metadata",
] as const;

export type SupersedeNodeRequest = {
  workspace_name: string;
  node_id: string;
  /** The pinned CURRENT head. Forced, not optional: old_revision_id is a
   *  physical NOT NULL column. */
  expected_revision_id: string;
  new_node_id: string;
  new_revision_id: string;
  reason: string;
  peer_name: string | null;
  operation_id: string;
};

export type RetireNodeRequest = {
  workspace_name: string;
  node_id: string;
  expected_revision_id: string;
  reason: string;
  peer_name: string | null;
  operation_id: string;
};

export type GetRecallEligibilityRequest = { workspace_name: string; node_id: string };

export type ListLifecycleHistoryRequest = {
  workspace_name: string;
  node_id: string;
  after_event_id: string | null;
  limit: number;
};
