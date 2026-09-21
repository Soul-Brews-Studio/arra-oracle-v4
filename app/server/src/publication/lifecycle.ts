/**
 * #29 (Parent #28) node lifecycle -- the PURE half.
 *
 * Request grammar and the stored-row codec for supersede/retire events, with
 * no SDK, connection or owner import. Everything here is decidable from bytes
 * alone, or from one already-selected stored row.
 *
 * MEASURED: `supersede_log` carries NO event-kind column. supersede vs retire
 * is distinguished ONLY by `new_id`/`new_revision_id` being null (a
 * retirement) or both non-null (a supersession) -- there is no third
 * spelling, and a row with exactly one of the pair null is corruption this
 * codec refuses rather than guesses at.
 */

import {
  requireBoundedText,
  requireClosedObject,
  requireNanoid21,
  requireNonemptyString,
  type Tokens,
} from "../contracts/common";
import { fail } from "../contracts/errors";
import {
  hasOnlyPairedSurrogates,
  parseStrictBytes,
  type JcsObject,
  type JcsValue,
} from "../contracts/jcs";
import { failPublication } from "./errors";
import { microsToTimestamp, toInt64Text } from "./rows";

const MAX_REQUEST_BYTES = 1048576;
const MAX_REQUEST_DEPTH = 64;
const MAX_NAME_BYTES = 256;
/** No physical bound is declared for `reason`; this is a CHOSEN wire cap for
 *  this grammar, not a schema fact. */
const MAX_REASON_BYTES = 4096;
/** Page size ceiling for listLifecycleHistory. A small JSON integer, NOT an
 *  Int64 wire field. */
export const MAX_HISTORY_LIMIT = 100;

const SUPERSEDE_KEYS = [
  "workspace_name",
  "node_id",
  "expected_revision_id",
  "new_node_id",
  "new_revision_id",
  "reason",
  "peer_name",
  "operation_id",
] as const;
const RETIRE_KEYS = [
  "workspace_name",
  "node_id",
  "expected_revision_id",
  "reason",
  "peer_name",
  "operation_id",
] as const;
const ELIGIBILITY_KEYS = ["workspace_name", "node_id"] as const;
const HISTORY_KEYS = ["workspace_name", "node_id", "after_event_id", "limit"] as const;

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

function parseRequest(bytes: Uint8Array, tokens: Tokens = []): JcsObject {
  if (!(bytes instanceof Uint8Array)) {
    // A non-bytes entrypoint would be a second, ungoverned parser path.
    fail("invalid_type", tokens, "expected request bytes");
  }
  const parsed = parseStrictBytes(bytes, tokens, {
    maxBytes: MAX_REQUEST_BYTES,
    maxDepth: MAX_REQUEST_DEPTH,
  });
  if (!(parsed instanceof Map)) fail("invalid_type", tokens, "expected object");
  return parsed as JcsObject;
}

/** Nonempty valid Unicode, 256 UTF-8 bytes. No trim, no case fold, no NFC. */
function name(value: JcsValue | undefined, tokens: Tokens): string {
  return requireBoundedText(requireNonemptyString(value ?? null, tokens), MAX_NAME_BYTES, tokens);
}

function nullableName(value: JcsValue | undefined, tokens: Tokens): string | null {
  return value === null || value === undefined ? null : name(value, tokens);
}

/** The declared node/revision namespace: nanoid21, statically. */
function nodeId(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNanoid21(value ?? null, tokens);
}

/**
 * `reason` is a physical NOT NULL column, so the request grammar makes it a
 * required field -- there is no null spelling to carry forward.
 */
function reason(value: JcsValue | undefined, tokens: Tokens): string {
  return requireBoundedText(requireNonemptyString(value ?? null, tokens), MAX_REASON_BYTES, tokens);
}

/**
 * Operation grammar: nonempty valid Unicode, deliberately NOT nanoid-shaped.
 * The caller owns this key across retries; narrowing it here would reject
 * legitimate operation IDs the contract allows. Mirrors requireOperationId in
 * service.ts, which this module cannot import (SDK-adjacent file).
 */
function operationId(value: JcsValue | undefined, tokens: Tokens): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_type", tokens, "expected nonempty string");
  }
  if (!hasOnlyPairedSurrogates(value)) fail("invalid_unicode", tokens, "unpaired surrogate");
  return value;
}

/** Canonical signed Int64 decimal TEXT. Never a JSON number. */
function int64Text(value: JcsValue | undefined, tokens: Tokens): string {
  if (typeof value !== "string") fail("invalid_type", tokens, "expected Int64 decimal string");
  // `-0` matches a naive `-?(0|[1-9]...)` and is NOT canonical.
  if (value === "-0" || !/^-?(0|[1-9][0-9]*)$/.test(value)) {
    fail("invalid_value", tokens, "expected canonical decimal");
  }
  const parsed = BigInt(value);
  if (parsed < -(2n ** 63n) || parsed > 2n ** 63n - 1n) fail("invalid_value", tokens, "outside Int64");
  return value;
}

export function parseSupersedeNode(bytes: Uint8Array): SupersedeNodeRequest {
  const request = requireClosedObject(parseRequest(bytes), SUPERSEDE_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    node_id: nodeId(request.get("node_id"), ["node_id"]),
    expected_revision_id: nodeId(request.get("expected_revision_id"), ["expected_revision_id"]),
    new_node_id: nodeId(request.get("new_node_id"), ["new_node_id"]),
    new_revision_id: nodeId(request.get("new_revision_id"), ["new_revision_id"]),
    reason: reason(request.get("reason"), ["reason"]),
    peer_name: nullableName(request.get("peer_name"), ["peer_name"]),
    operation_id: operationId(request.get("operation_id"), ["operation_id"]),
  };
}

export function parseRetireNode(bytes: Uint8Array): RetireNodeRequest {
  const request = requireClosedObject(parseRequest(bytes), RETIRE_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    node_id: nodeId(request.get("node_id"), ["node_id"]),
    expected_revision_id: nodeId(request.get("expected_revision_id"), ["expected_revision_id"]),
    reason: reason(request.get("reason"), ["reason"]),
    peer_name: nullableName(request.get("peer_name"), ["peer_name"]),
    operation_id: operationId(request.get("operation_id"), ["operation_id"]),
  };
}

export function parseGetRecallEligibility(bytes: Uint8Array): GetRecallEligibilityRequest {
  const request = requireClosedObject(parseRequest(bytes), ELIGIBILITY_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    node_id: nodeId(request.get("node_id"), ["node_id"]),
  };
}

export function parseListLifecycleHistory(bytes: Uint8Array): ListLifecycleHistoryRequest {
  const request = requireClosedObject(parseRequest(bytes), HISTORY_KEYS, []);
  const rawLimit = request.get("limit");
  // A small JSON integer, deliberately: the page size is not an Int64 wire
  // field, so a decimal string here is a type error rather than a cursor.
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_HISTORY_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_HISTORY_LIMIT}`);
  }
  const rawAfter = request.get("after_event_id");
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    node_id: nodeId(request.get("node_id"), ["node_id"]),
    after_event_id: rawAfter === null ? null : int64Text(rawAfter, ["after_event_id"]),
    limit: rawLimit,
  };
}

/* ------------------------------------------------------------------ *
 * Stored row codec. Stored-state faults are integrity_failure at ROOT:
 * no request pointer names a row the caller never supplied.
 * ------------------------------------------------------------------ */

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

/** RAW microseconds to the exact wire millisecond string. See read-cursor.ts. */
function storedTimestamp(value: unknown): string {
  if (typeof value === "bigint") return microsToTimestamp(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return microsToTimestamp(BigInt(value));
  }
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

/**
 * True for a supersession, false for a retirement. Call only on the result of
 * `encodeSupersedeLogRow`, which has already proven the new_id/new_revision_id
 * pair agrees.
 */
export function isSupersedeEvent(encoded: Record<string, unknown>): boolean {
  return encoded.new_id !== null;
}
