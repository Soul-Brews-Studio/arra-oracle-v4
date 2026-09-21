/**
 * Constants used by two or more of the association.*.ts sibling files (and,
 * in most cases, imported directly by service.ts and the test suite too), so
 * they live here rather than beside a single function.
 */

/** Exactly the two modes. `current` means HEAD -- not a lifecycle filter. */
export const REVISION_MODES = ["current", "history"] as const;
export type RevisionMode = (typeof REVISION_MODES)[number];

export const MAX_PAGE_LIMIT = 100;
/** Traversal budgets, per call. Application limits, NOT a bound on SDK work. */
export const MAX_VISITED_NODES = 32;
export const MAX_SELECTED_REVISIONS = 128;
export const MAX_EXAMINED_POSITIONS = 4096;
export const MAX_RESULT_WIRE_BYTES = 16 * 1024 * 1024;

/** Physical order, quoted from the contract. No invented link id. */
export const TERM_FIELDS = [
  "workspace_name", "revision_id", "term_id", "vocabulary_id",
  "vocabulary_name_snapshot", "term_name_snapshot", "label_snapshot", "position",
] as const;
export const LINK_FIELDS = [
  "workspace_name", "revision_id", "position", "relation", "target_kind",
  "target", "target_key", "excerpt", "content_hash", "captured_at",
  "capture_status", "note",
] as const;

export const CURSOR_KEYS = [
  "workspace_name", "target_kind", "target_key", "revision_mode",
  "nodes_version", "node_id", "revision_no", "position",
] as const;
