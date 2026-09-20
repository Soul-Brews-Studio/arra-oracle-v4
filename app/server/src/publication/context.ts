/**
 * Context request grammar and physical row encoding.
 *
 * PURE by contract. No SDK import, and nothing here acquires, retains or
 * returns a connection, table, adapter or owner. Persistence stays private in
 * service.ts, so this module can be exercised without a dataset and cannot
 * become a back door to one.
 *
 * TWO envelopes, deliberately, and neither is new:
 *   - governed ContractError / arra-error/v1 for parse, shape and value. Those
 *     come from the shared `contracts/common` helpers, so RFC 6901 escaping and
 *     deterministic unknown-key ordering are inherited rather than reimplemented.
 *   - PublicationError / arra-publication-error/v1 for STORED-state failures.
 *     The historical version name is deliberate reuse; it is not a claim that
 *     this module publishes knowledge.
 *
 * Contract: app/docs/contracts/context-ingestion-v1.md
 */

import {
  requireBoundedText,
  requireClosedObject,
  requireNanoid21,
  requireNonemptyString,
  requireNullableString,
  requireNullableTimestampString,
  requireSha256Hex,
  requireUnicodeString,
  type Tokens,
} from "../contracts/common";
import { fail } from "../contracts/errors";
import { hasOnlyPairedSurrogates, parseStrictBytes, type JcsObject, type JcsValue } from "../contracts/jcs";
import { prepareNewMessage, validateStoredSourceState } from "../contracts/source-ingestion-v1";
import { failPublication } from "./errors";
import { utf8ByteLength } from "./rows";

const MAX_REQUEST_BYTES = 1048576;
const MAX_REQUEST_DEPTH = 64;
const MAX_NAME_BYTES = 256;

/** Items per batch. Nonempty, and no more than this. */
export const MAX_ITEMS = 128;
/** Cumulative JSON UTF-8 budget for result-row arrays. A RESPONSE bound only:
 *  it implies nothing about Arrow allocation or process RSS. */
export const MAX_RESULT_WIRE_BYTES = 16 * 1024 * 1024;
/** Page size ceiling for listMessages. A small JSON integer, NOT an Int64. */
export const MAX_PAGE_LIMIT = 100;

/** Physical order, quoted from target_v1/core.py. Not invented here. */
export const PEER_FIELDS = [
  "id", "name", "workspace_name", "h_metadata", "internal_metadata", "configuration", "created_at",
] as const;
export const SESSION_FIELDS = [
  "id", "name", "workspace_name", "is_active", "h_metadata", "internal_metadata", "configuration", "created_at",
] as const;
export const SESSION_PEER_FIELDS = [
  "workspace_name", "session_name", "peer_name", "configuration", "internal_metadata", "joined_at", "left_at",
] as const;
export const MESSAGE_FIELDS = [
  "id", "public_id", "workspace_name", "session_name", "peer_name", "content", "token_count",
  "seq_in_session", "h_metadata", "internal_metadata", "created_at", "role", "in_reply_to",
  "read", "read_at", "source_namespace", "source_message_id", "source_payload_digest",
  "source_created_at", "ingested_at",
] as const;

const MESSAGE_KEYS = ["peer_name", "role", "content", "in_reply_to"] as const;
const SOURCE_KEYS = ["source_message_id", "source_created_at", "supplied_digest"] as const;
const ITEM_KEYS = ["public_id", "message", "source"] as const;

/* ------------------------------------------------------------------ *
 * Request grammar. Governed envelope throughout.
 * ------------------------------------------------------------------ */

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

function nanoid(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNanoid21(value ?? null, tokens);
}

function nullableNanoid(value: JcsValue | undefined, tokens: Tokens): string | null {
  return value === null ? null : nanoid(value, tokens);
}

/** Canonical signed Int64 decimal TEXT. Never a JSON number. */
function int64Text(value: JcsValue | undefined, tokens: Tokens): string {
  if (typeof value !== "string") fail("invalid_type", tokens, "expected Int64 decimal string");
  // `-0` matches a naive `-?(0|[1-9]...)` and is NOT canonical: it is a second
  // spelling of zero, so a cursor could round-trip differently than it arrived.
  if (value === "-0" || !/^-?(0|[1-9][0-9]*)$/.test(value)) {
    fail("invalid_value", tokens, "expected canonical decimal");
  }
  const parsed = BigInt(value);
  if (parsed < -(2n ** 63n) || parsed > 2n ** 63n - 1n) fail("invalid_value", tokens, "outside Int64");
  return value;
}

export type RegisterPeerRequest = { workspace_name: string; peer_id: string; name: string };
export type RegisterSessionRequest = { workspace_name: string; session_id: string; name: string };
export type JoinSessionRequest = { workspace_name: string; session_name: string; peer_name: string };
export type GetPeerRequest = { workspace_name: string; peer_name: string };
export type GetSessionRequest = { workspace_name: string; session_name: string };
export type GetMessageRequest = { workspace_name: string; public_id: string };
export type ListMessagesRequest = {
  workspace_name: string;
  session_name: string;
  after_seq: string | null;
  limit: number;
};
export type AppendItem = {
  public_id: string;
  message: Record<string, unknown>;
  source: Record<string, unknown> | null;
};
export type AppendMessagesRequest = {
  workspace_name: string;
  session_name: string;
  items: AppendItem[];
};

export function parseRegisterPeer(bytes: Uint8Array): RegisterPeerRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "peer_id", "name"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    peer_id: nanoid(o.get("peer_id"), ["peer_id"]),
    name: name(o.get("name"), ["name"]),
  };
}

export function parseRegisterSession(bytes: Uint8Array): RegisterSessionRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "session_id", "name"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_id: nanoid(o.get("session_id"), ["session_id"]),
    name: name(o.get("name"), ["name"]),
  };
}

export function parseJoinSession(bytes: Uint8Array): JoinSessionRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "session_name", "peer_name"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    peer_name: name(o.get("peer_name"), ["peer_name"]),
  };
}

export function parseGetPeer(bytes: Uint8Array): GetPeerRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "peer_name"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    peer_name: name(o.get("peer_name"), ["peer_name"]),
  };
}

export function parseGetSession(bytes: Uint8Array): GetSessionRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "session_name"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
  };
}

export function parseGetMessage(bytes: Uint8Array): GetMessageRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "public_id"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    public_id: nanoid(o.get("public_id"), ["public_id"]),
  };
}

export function parseListMessages(bytes: Uint8Array): ListMessagesRequest {
  const o = requireClosedObject(
    parseRequest(bytes),
    ["workspace_name", "session_name", "after_seq", "limit"],
    [],
  );
  const rawLimit = o.get("limit");
  // A small JSON integer, deliberately: the page size is not an Int64 wire
  // field, so a decimal string here is a type error rather than a cursor.
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_PAGE_LIMIT}`);
  }
  const rawAfter = o.get("after_seq");
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    after_seq: rawAfter === null ? null : int64Text(rawAfter, ["after_seq"]),
    limit: rawLimit,
  };
}

export function parseAppendMessages(bytes: Uint8Array): AppendMessagesRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "session_name", "items"], []);
  const rawItems = o.get("items");
  if (!Array.isArray(rawItems)) fail("invalid_type", ["items"], "expected array");
  if (rawItems.length === 0) fail("invalid_value", ["items"], "must be nonempty");
  if (rawItems.length > MAX_ITEMS) {
    fail("limit_exceeded", ["items"], `at most ${MAX_ITEMS} items`);
  }

  const items: AppendItem[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawItems.entries()) {
    const at = (...rest: Array<string | number>): Tokens => ["items", index, ...rest];
    const entry = requireClosedObject(raw, ITEM_KEYS, ["items", index]);
    const publicId = nanoid(entry.get("public_id"), at("public_id"));
    // The LATER occurrence is the one that collides with what came before.
    if (seen.has(publicId)) fail("invalid_value", at("public_id"), "duplicate public_id");
    seen.add(publicId);

    // TYPE and FORMAT of the whole input are settled HERE, before admission.
    // A malformed later item must refuse the request before any earlier row is
    // written -- otherwise a durable prefix is created for input that was never
    // well formed. Only source MODE agreement, supplied-digest EQUALITY and
    // foreign references stay per-item, because those are semantics rather
    // than shape.
    //
    // Every check below is a governed helper, not a second parser: the field
    // grammars, RFC 6901 escaping and error envelope all come from the shared
    // codec.
    const message = requireClosedObject(entry.get("message") ?? null, MESSAGE_KEYS, at("message"));
    requireBoundedText(
      requireNonemptyString(message.get("peer_name") ?? null, at("message", "peer_name")),
      MAX_NAME_BYTES,
      at("message", "peer_name"),
    );
    requireNullableString(message.get("role") ?? null, at("message", "role"));
    // Content may be EMPTY -- that is prepareNewMessage's accepted grammar, and
    // tightening it here would reject input the codec allows.
    requireUnicodeString(message.get("content") ?? null, at("message", "content"));
    const replyTo = message.get("in_reply_to") ?? null;
    if (replyTo !== null) requireNanoid21(replyTo, at("message", "in_reply_to"));

    const rawSource = entry.get("source");
    const source =
      rawSource === null ? null : requireClosedObject(rawSource ?? null, SOURCE_KEYS, at("source"));
    if (source !== null) {
      requireNonemptyString(source.get("source_message_id") ?? null, at("source", "source_message_id"));
      requireNullableTimestampString(source.get("source_created_at") ?? null, at("source", "source_created_at"));
      const supplied = source.get("supplied_digest") ?? null;
      // Format only. Whether it MATCHES the recomputed envelope digest is
      // per-item semantics and stays with prepareNewMessage.
      if (supplied !== null) requireSha256Hex(supplied, at("source", "supplied_digest"));
    }

    items.push({
      public_id: publicId,
      message: Object.fromEntries(message) as Record<string, unknown>,
      source: source === null ? null : (Object.fromEntries(source) as Record<string, unknown>),
    });
  }

  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    items,
  };
}

/* ------------------------------------------------------------------ *
 * Physical row encoding. STORED-state failures only, integrity at root.
 * ------------------------------------------------------------------ */

const MICROS_PER_MILLI = 1000n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
/** Gregorian 0001-01-01 .. 9999-12-31T23:59:59.999, in epoch milliseconds.
 *  The SUPPORTED range, which is narrower than what JS Date will render --
 *  Date happily prints +010000-01-01T00:00:00.000Z for year 10000. */
const MIN_EPOCH_MS = -62135596800000n;
const MAX_EPOCH_MS = 253402300799999n;
const NANOID21 = /^[A-Za-z0-9_-]{21}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Raw Arrow cell -> microseconds. No Date fallback: a Date has ALREADY lost
 *  whatever sub-millisecond precision the timestamp[us] column held. */
function rawMicros(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure");
    return BigInt(value);
  }
  return failPublication("integrity_failure");
}

/** Exact UTC millisecond text. The remainder is rejected BEFORE any Number
 *  conversion, so a stored time is never rounded into one the store lacks. */
function storedTimestamp(value: unknown): string {
  const micros = rawMicros(value);
  if (micros % MICROS_PER_MILLI !== 0n) failPublication("integrity_failure");
  const millis = micros / MICROS_PER_MILLI;
  // The SUPPORTED range, not the JS Date range.
  if (millis < MIN_EPOCH_MS || millis > MAX_EPOCH_MS) failPublication("integrity_failure");
  const text = new Date(Number(millis)).toISOString();
  if (Date.parse(text) !== Number(millis)) failPublication("integrity_failure");
  return text;
}

function storedNullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : storedTimestamp(value);
}

/** Exact signed Int64 as canonical decimal TEXT. Never via Number. */
function storedInt64(value: unknown, opts: { min?: bigint } = {}): string {
  let parsed: bigint;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure");
    parsed = BigInt(value);
  } else return failPublication("integrity_failure");
  if (parsed < INT64_MIN || parsed > INT64_MAX) failPublication("integrity_failure");
  if (opts.min !== undefined && parsed < opts.min) failPublication("integrity_failure");
  return parsed.toString(10);
}

/** Content MAY be empty -- that is the governed grammar -- but it must still
 *  be valid Unicode. A lone surrogate is not a string a caller can round-trip. */
function storedContent(value: unknown): string {
  if (typeof value !== "string") failPublication("integrity_failure");
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure");
  return value;
}

/** Nonempty, and genuinely valid Unicode. A lone surrogate is not a string a
 *  caller can round-trip, so it is corruption rather than content. */
function storedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) failPublication("integrity_failure");
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure");
  return value;
}

/** A stored scoped name: valid Unicode, bounded at 256 UTF-8 BYTES. */
function storedName(value: unknown): string {
  const text = storedText(value);
  if (utf8ByteLength(text) > MAX_NAME_BYTES) failPublication("integrity_failure");
  return text;
}

/** A stored identifier must satisfy the nanoid21 grammar, not merely be a string. */
function storedId(value: unknown): string {
  const text = storedText(value);
  if (!NANOID21.test(text)) failPublication("integrity_failure");
  return text;
}

/** Optional JSON column: retained BYTE-FOR-BYTE. This slice does not parse or
 *  recanonicalize its contents. */
function storedNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") failPublication("integrity_failure");
  // EMPTY is a legitimate retained value; a lone surrogate is not. This slice
  // does not parse the JSON contents, only require the string be well formed.
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure");
  return value;
}

function storedBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") failPublication("integrity_failure");
  return value;
}

function storedNullableBoolean(value: unknown): boolean | null {
  return value === null || value === undefined ? null : storedBoolean(value);
}

function ordered(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = row[field];
  return out;
}

export function encodePeerRow(row: Record<string, unknown>): Record<string, unknown> {
  return ordered({
    id: storedId(row.id),
    name: storedName(row.name),
    workspace_name: storedName(row.workspace_name),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    configuration: storedNullableText(row.configuration),
    created_at: storedTimestamp(row.created_at),
  }, PEER_FIELDS);
}

export function encodeSessionRow(row: Record<string, unknown>): Record<string, unknown> {
  return ordered({
    id: storedId(row.id),
    name: storedName(row.name),
    workspace_name: storedName(row.workspace_name),
    is_active: storedBoolean(row.is_active),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    configuration: storedNullableText(row.configuration),
    created_at: storedTimestamp(row.created_at),
  }, SESSION_FIELDS);
}

export function encodeSessionPeerRow(row: Record<string, unknown>): Record<string, unknown> {
  return ordered({
    workspace_name: storedName(row.workspace_name),
    session_name: storedName(row.session_name),
    peer_name: storedName(row.peer_name),
    configuration: storedNullableText(row.configuration),
    internal_metadata: storedNullableText(row.internal_metadata),
    joined_at: storedTimestamp(row.joined_at),
    left_at: storedNullableTimestamp(row.left_at),
  }, SESSION_PEER_FIELDS);
}

export function encodeMessageRow(row: Record<string, unknown>): Record<string, unknown> {
  const content = storedContent(row.content);
  const createdAt = storedTimestamp(row.created_at);
  const ingestedAt = storedTimestamp(row.ingested_at);
  const sourceCreatedAt = storedNullableTimestamp(row.source_created_at);

  // SHAPE of the stored source state, through the ACCEPTED validator rather
  // than a hand-rolled all-or-none check.
  let stored: Record<string, unknown>;
  try {
    stored = validateStoredSourceState(JSON.stringify({
      source_namespace: row.source_namespace ?? null,
      source_message_id: row.source_message_id ?? null,
      source_payload_digest: row.source_payload_digest ?? null,
      source_created_at: sourceCreatedAt,
      ingested_at: ingestedAt,
    }));
  } catch {
    return failPublication("integrity_failure");
  }
  const namespace = stored.source_namespace as string | null;
  const sourceId = stored.source_message_id as string | null;
  const digest = stored.source_payload_digest as string | null;

  if (namespace !== null) {
    // RECOMPUTE, do not merely shape-check. A lowercase-hex 64 is a shape; it
    // says nothing about the content it claims to cover, so a tampered row
    // carrying its ORIGINAL digest would otherwise read back as healthy.
    //
    // The accepted boundary is prepareNewMessage: it is the only place that
    // holds the message envelope, and validateStoredSourceState says so in
    // its own words. Passing the stored digest as `supplied_digest` makes the
    // codec compare recomputed against stored for us -- no second digest
    // implementation lives here.
    try {
      prepareNewMessage(JSON.stringify({
        context: {
          workspace_name: row.workspace_name ?? null,
          session_name: row.session_name ?? null,
          intake_at: ingestedAt,
          source_namespace: namespace,
        },
        message: {
          peer_name: row.peer_name ?? null,
          role: row.role ?? null,
          content,
          in_reply_to: row.in_reply_to ?? null,
        },
        source: {
          source_message_id: sourceId,
          source_created_at: sourceCreatedAt,
          supplied_digest: digest,
        },
      }));
    } catch {
      // Any failure here is STORED-state corruption, at the root path: the
      // caller sent nothing wrong.
      return failPublication("integrity_failure");
    }
  }

  return ordered({
    id: storedInt64(row.id),
    public_id: storedId(row.public_id),
    workspace_name: storedName(row.workspace_name),
    session_name: storedName(row.session_name),
    peer_name: storedName(row.peer_name),
    content,
    // Negative token_count is corruption, not a value to carry forward.
    token_count: storedInt64(row.token_count, { min: 0n }),
    seq_in_session: storedInt64(row.seq_in_session),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    created_at: createdAt,
    role: storedNullableText(row.role),
    // A reply target is an identifier, so it carries the identifier grammar.
    in_reply_to: row.in_reply_to === null || row.in_reply_to === undefined ? null : storedId(row.in_reply_to),
    read: storedNullableBoolean(row.read),
    read_at: storedNullableTimestamp(row.read_at),
    source_namespace: namespace,
    source_message_id: sourceId,
    source_payload_digest: digest,
    source_created_at: sourceCreatedAt,
    ingested_at: ingestedAt,
  }, MESSAGE_FIELDS);
}

/** Encoded JSON size of one result row, in UTF-8 BYTES. A string length would
 *  under-count every non-ASCII character. */
export function rowWireBytes(row: Record<string, unknown>): number {
  return utf8ByteLength(JSON.stringify(row));
}
