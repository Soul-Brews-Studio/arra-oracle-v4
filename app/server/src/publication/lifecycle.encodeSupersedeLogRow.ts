import { hasOnlyPairedSurrogates } from "../contracts/jcs";
import { failPublication } from "./errors";
import { MAX_NAME_BYTES, SUPERSEDE_LOG_FIELDS } from "./lifecycle.constants";
import { microsToTimestamp } from "./rows.microsToTimestamp";
import { toInt64Text } from "./rows.toInt64Text";

/** Presence, own, and nothing else. See read-cursor.ts for the full rationale. */
function requireExactColumns(row: unknown, fields: readonly string[]): Record<string, unknown> {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    failPublication("integrity_failure", "");
  }
  const actual = Object.keys(row as Record<string, unknown>);
  if (actual.length !== fields.length) failPublication("integrity_failure", "");
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) {
      failPublication("integrity_failure", "");
    }
  }
  return row as Record<string, unknown>;
}

/** Valid Unicode, through the ACCEPTED surrogate check. */
function storedText(value: unknown): string {
  if (typeof value !== "string") failPublication("integrity_failure", "");
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure", "");
  return value;
}

function storedRequiredText(value: unknown): string {
  return storedText(value);
}

/** EXPLICIT null only, or valid Unicode text. */
function storedNullableText(value: unknown): string | null {
  if (value === null) return null;
  return storedText(value);
}

function storedName(value: unknown): string {
  const text = storedText(value);
  if (text.length === 0) failPublication("integrity_failure", "");
  if (new TextEncoder().encode(text).length > MAX_NAME_BYTES) failPublication("integrity_failure", "");
  return text;
}

function storedNullableName(value: unknown): string | null {
  if (value === null) return null;
  return storedName(value);
}

/** The declared node/revision namespace, REQUIRED: exactly 21 URL-safe chars. */
function storedNanoid(value: unknown): string {
  const text = storedText(value);
  if (!/^[A-Za-z0-9_-]{21}$/.test(text)) failPublication("integrity_failure", "");
  return text;
}

function storedNullableNanoid(value: unknown): string | null {
  if (value === null) return null;
  return storedNanoid(value);
}

function storedId(value: unknown): string {
  if (typeof value !== "bigint") failPublication("integrity_failure", "");
  return toInt64Text(value);
}

/**
 * RAW microseconds to the exact wire millisecond string. See read-cursor.ts.
 * `bigint` ONLY (#105): a plain JS `number` here can only be a lossy
 * MILLISECOND read from the client's `toArray()`/`.get()` accessor mistaken
 * for microseconds -- see `context.rawMicros.ts` for the full rationale.
 */
function storedTimestamp(value: unknown): string {
  if (typeof value === "bigint") return microsToTimestamp(value);
  return failPublication("integrity_failure", "");
}

/**
 * One stored `supersede_log` row to its exact 16 wire fields, in physical
 * order.
 *
 * `old_source`/`new_source` have no origin anywhere in this schema -- nothing
 * that writes through this codec ever supplies one -- so a non-null stored
 * value there is corruption, never a value this decoder invents or repairs.
 */
export function encodeSupersedeLogRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, SUPERSEDE_LOG_FIELDS);

  const oldSource = storedNullableText(row.old_source);
  if (oldSource !== null) failPublication("integrity_failure", "");
  const newSource = storedNullableText(row.new_source);
  if (newSource !== null) failPublication("integrity_failure", "");

  const newId = storedNullableNanoid(row.new_id);
  const newRevisionId = storedNullableNanoid(row.new_revision_id);
  // No event-kind column exists: supersede vs retire is distinguished ONLY by
  // new_id/new_revision_id both null (retire) or both non-null (supersede).
  // Exactly one of the pair being null is a state this codec never invents an
  // answer for.
  if ((newId === null) !== (newRevisionId === null)) failPublication("integrity_failure", "");

  return {
    id: storedId(row.id),
    workspace_name: storedName(row.workspace_name),
    old_id: storedNanoid(row.old_id),
    old_revision_id: storedNanoid(row.old_revision_id),
    old_title: storedNullableText(row.old_title),
    old_type: storedNullableText(row.old_type),
    old_source: oldSource,
    new_id: newId,
    new_revision_id: newRevisionId,
    new_title: storedNullableText(row.new_title),
    new_source: newSource,
    reason: storedRequiredText(row.reason),
    peer_name: storedNullableName(row.peer_name),
    superseded_at: storedTimestamp(row.superseded_at),
    operation_id: storedRequiredText(row.operation_id),
    h_metadata: storedNullableText(row.h_metadata),
  };
}
