/**
 * Shared constants and field lists for the rows.* split files. No exported
 * functions here (values and types only), so this file sits outside the
 * one-exported-function-per-file ratchet by construction -- it exists purely
 * so the split files never duplicate a literal.
 */

/** Exactly the five physical Node columns, in target schema order. */
export const NODE_FIELDS = [
  "id",
  "workspace_name",
  "current_revision_id",
  "created_at",
  "updated_at",
] as const;

/** Exactly the 26 physical NodeRevision columns, in target schema order. */
export const REVISION_FIELDS = [
  "id",
  "workspace_name",
  "node_id",
  "revision_no",
  "base_revision_id",
  "operation_id",
  "title",
  "body",
  "body_format",
  "fields",
  "author_peer_name",
  "observer_peer_name",
  "subject_peer_name",
  "session_name",
  "is_active",
  "valid_from",
  "valid_to",
  "change_reason",
  "created_at",
  "schema_version",
  "canonical_version",
  "content_digest",
  "term_snapshot_json",
  "link_snapshot_json",
  "h_metadata",
  "internal_metadata",
] as const;

export type NodeField = (typeof NODE_FIELDS)[number];
export type RevisionField = (typeof REVISION_FIELDS)[number];

/** Int64-valued physical columns: decimal text on the wire, BigInt in memory. */
export const INT64_REVISION_FIELDS = new Set<RevisionField>(["revision_no", "schema_version"]);
/** timestamp[us] columns, stored without timezone. */
export const TIMESTAMP_REVISION_FIELDS = new Set<RevisionField>(["valid_from", "valid_to", "created_at"]);
export const TIMESTAMP_NODE_FIELDS = new Set<NodeField>(["created_at", "updated_at"]);

export const MICROS_PER_MILLI = 1000n;
/** Gregorian 0001-01-01 .. 9999-12-31T23:59:59.999 in epoch milliseconds. */
export const MIN_EPOCH_MS = -62135596800000n;
export const MAX_EPOCH_MS = 253402300799999n;

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

/** Canonical decimal text: no leading zeros, no plus sign, `0` for zero. */
export const CANONICAL_INT64 = /^(?:0|-?[1-9][0-9]*)$/;

/** UTF-8 byte length budget helpers. `[]` is 2 bytes for the empty array. */
export const EMPTY_ARRAY_BYTES = 2;

/** 16 MiB exactly. Equality is ACCEPTED; only greater-than is rejected. */
export const MAX_CHAIN_WIRE_BYTES = 16 * 1024 * 1024;
/** At most 1024 rows of accepted ancestry per requested node. */
export const MAX_CHAIN_ROWS = 1024;
