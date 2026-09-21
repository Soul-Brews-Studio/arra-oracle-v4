/**
 * #71 (Parent #28) read cursors -- the PURE half.
 *
 * Contract: app/docs/contracts/read-cursor-v1.md
 * SHA256 04f553dd20f572d6bc9c83b1c8752e69018ff5556ad2b2b1b1308162ca82f24f
 *
 * Request grammar and the stored-row codec, with no SDK, connection or owner
 * import. Everything here is decidable from bytes alone.
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
import { microsToTimestamp } from "./rows";

const MAX_REQUEST_BYTES = 1048576;
const MAX_REQUEST_DEPTH = 64;
const MAX_NAME_BYTES = 256;

/** The exact physical field order of a stored cursor row. */
export const READ_CURSOR_FIELDS = [
  "workspace_name",
  "peer_name",
  "session_name",
  "last_read_message_id",
  "last_read_at",
] as const;

const GET_KEYS = ["workspace_name", "peer_name", "session_name"] as const;
const ADVANCE_KEYS = [
  "workspace_name",
  "peer_name",
  "session_name",
  "last_read_message_id",
  "expected",
] as const;
const EXPECTED_KEYS = ["last_read_message_id"] as const;

export type GetReadCursorRequest = {
  workspace_name: string;
  peer_name: string;
  session_name: string;
};

/**
 * `expected` is a TOTAL prior-state guard with three distinct values:
 *   null                      -- the row must be ABSENT
 *   { last_read_message_id: null }  -- present row, null POINTER
 *   { last_read_message_id: N }     -- present row, that exact pointer
 *
 * Absent and present-with-null-pointer are different states, so they cannot
 * share one spelling.
 */
export type AdvanceReadCursorRequest = {
  workspace_name: string;
  peer_name: string;
  session_name: string;
  last_read_message_id: string;
  expected: { last_read_message_id: string | null } | null;
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

/**
 * The declared namespace is message.public_id, which is nanoid21.
 *
 * A legacy decimal message.id such as "42" fails this grammar statically, and
 * deliberately: there is no numeric alias and no fallback lookup, so a request
 * naming the wrong identity is refused before it can reach the store.
 */
function publicId(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNanoid21(value ?? null, tokens);
}

export function parseGetReadCursor(bytes: Uint8Array): GetReadCursorRequest {
  const request = requireClosedObject(parseRequest(bytes), GET_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    peer_name: name(request.get("peer_name"), ["peer_name"]),
    session_name: name(request.get("session_name"), ["session_name"]),
  };
}

export function parseAdvanceReadCursor(bytes: Uint8Array): AdvanceReadCursorRequest {
  const request = requireClosedObject(parseRequest(bytes), ADVANCE_KEYS, []);
  const rawExpected = request.get("expected");
  let expected: { last_read_message_id: string | null } | null = null;
  if (rawExpected !== null) {
    const guard = requireClosedObject(rawExpected ?? null, EXPECTED_KEYS, ["expected"]);
    const pointer = guard.get("last_read_message_id");
    expected = {
      last_read_message_id:
        pointer === null ? null : publicId(pointer, ["expected", "last_read_message_id"]),
    };
  }
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    peer_name: name(request.get("peer_name"), ["peer_name"]),
    session_name: name(request.get("session_name"), ["session_name"]),
    // There is no nullable DESIRED position: a row is created only when a real
    // message is marked read.
    last_read_message_id: publicId(request.get("last_read_message_id"), ["last_read_message_id"]),
    expected,
  };
}

/* ------------------------------------------------------------------ *
 * Stored row codec. Stored-state faults are integrity_failure at ROOT:
 * no request pointer names a row the caller never supplied.
 * ------------------------------------------------------------------ */

/**
 * EXACTLY these columns: present, own, and nothing else.
 *
 * Presence alone is not the contracted shape -- an unknown column means the
 * row is not what this codec describes, and encoding it anyway would vouch
 * for state it never examined. `in` walks the prototype chain, so a row
 * missing a real column could otherwise look complete and then be encoded
 * from prototype data; `Object.prototype.hasOwnProperty.call` rather than the
 * row's own method, which a stored row could shadow.
 */
function requireExactColumns(row: unknown, fields: readonly string[]): Record<string, unknown> {
  // A malformed CONTAINER is refused before any field is read: an array or a
  // primitive is not a row, whatever it may happen to answer to.
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
  // A lone surrogate is not valid Unicode and must not reach the wire as a
  // replacement character.
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure", "");
  return value;
}

/**
 * A physical REQUIRED STRING: utf8, NOT NULL, and nothing further.
 *
 * Deliberately not the name grammar. Nonempty and the 256-byte bound are peer
 * and session semantics; importing them here from resemblance would refuse
 * rows this slice has no authority to reject.
 */
function storedRequiredText(value: unknown): string {
  return storedText(value);
}

function storedName(value: unknown): string {
  const text = storedText(value);
  if (text.length === 0) failPublication("integrity_failure", "");
  // The same bound the request grammar applies, measured in UTF-8 BYTES: a
  // stored name past it could never have been written through this service.
  if (new TextEncoder().encode(text).length > MAX_NAME_BYTES) {
    failPublication("integrity_failure", "");
  }
  return text;
}

function storedPointer(value: unknown): string | null {
  // EXPLICIT null only. `undefined` in a present column is a malformed row,
  // and reading it as "no pointer" would invent an absence the data never
  // stated -- the same distinction the request grammar draws.
  if (value === null) return null;
  if (typeof value !== "string") failPublication("integrity_failure", "");
  // A retained pointer must itself satisfy the declared namespace. A malformed
  // one is terminal through this interface rather than silently converted.
  if (!/^[A-Za-z0-9_-]{21}$/.test(value)) failPublication("integrity_failure", "");
  return value;
}

/**
 * RAW microseconds to the exact wire millisecond string.
 *
 * `last_read_at` carries no null spelling on the wire. A null, a
 * sub-millisecond remainder or an out-of-range value is stored-state
 * corruption, never rounded or clamped into something renderable -- and this
 * refusal holds whatever the physical engine does or does not admit, which is
 * why it is proven here rather than inferred from a column declaration.
 */
function storedTimestamp(value: unknown): string {
  if (typeof value === "bigint") return microsToTimestamp(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return microsToTimestamp(BigInt(value));
  }
  return failPublication("integrity_failure", "");
}

/** The seven physical workspace columns, in their stored order. */
export const WORKSPACE_FIELDS = [
  "id",
  "name",
  "created_at",
  "h_metadata",
  "internal_metadata",
  "configuration",
  "mission",
] as const;

/**
 * Validate the SELECTED workspace row, structurally.
 *
 * There is no accepted workspace encoder to delegate to, so this is a bounded
 * private validator for the one row this operation already selected -- not a
 * general workspace API and not a corpus audit. It describes exactly the seven
 * physical columns and nothing more.
 *
 * `id` is a required nonempty string and deliberately NOT a nanoid: peers and
 * sessions carry that namespace, workspaces do not, and inventing the
 * requirement here from resemblance would be a new identity decision this
 * slice has no authority to make.
 */
export function validateWorkspaceRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, WORKSPACE_FIELDS);
  return {
    // A physical required string, NOT a name and NOT a nanoid: this slice
    // makes no new identity decision about workspace ids.
    id: storedRequiredText(row.id),
    name: storedName(row.name),
    // RAW micros through the accepted conversion: a sub-millisecond remainder
    // or an out-of-range value is corruption here exactly as it is on a cursor.
    created_at: storedTimestamp(row.created_at),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    configuration: storedNullableText(row.configuration),
    mission: storedNullableText(row.mission),
  };
}

/**
 * EXPLICIT null, or valid Unicode text of any length.
 *
 * No invented bound: these columns carry opaque JSON documents, and the
 * physical schema states only utf8 nullable.
 */
function storedNullableText(value: unknown): string | null {
  if (value === null) return null;
  return storedText(value);
}

/** One stored row to its exact five wire fields, in physical order. */
export function encodeReadCursorRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, READ_CURSOR_FIELDS);
  return {
    workspace_name: storedName(row.workspace_name),
    peer_name: storedName(row.peer_name),
    session_name: storedName(row.session_name),
    last_read_message_id: storedPointer(row.last_read_message_id),
    last_read_at: storedTimestamp(row.last_read_at),
  };
}
