/**
 * #28 trace + trace_hit kernel -- the PURE half.
 *
 * Request grammar and the stored-row codecs, with no SDK, connection or owner
 * import. Style modelled on `./read-cursor.ts`.
 *
 * =====================================================================
 * CRITICAL UNIT TRAP, stated once here and never assumed elsewhere:
 *
 *   traces.created_at / updated_at / session_from_ts / session_to_ts are raw
 *   int64 MILLISECONDS.
 *   trace_hits.captured_at is timestamp[us], raw MICROSECONDS.
 *
 * The accepted `microsToTimestamp` / `timestampToMicros` helpers in `./rows`
 * are MICROS-ONLY. Reusing them on a `traces` millisecond column would
 * silently mis-scale the value by 1000x. This module therefore defines its
 * OWN millisecond converters (`millisToTimestamp` / `timestampToMillis`)
 * below, and uses the `./rows` micros converters ONLY for `trace_hits.captured_at`.
 * One writer spans two units in one serialized turn -- do not blur them.
 * =====================================================================
 *
 * `trace_hits` is AUTHORITATIVE, not derived: no accepted snapshot contains
 * hits and nothing can rebuild them. This module defines no materializer and
 * no scoped-delete authority over it.
 *
 * Traces and hits are IMMUTABLE in v1: there is no update method here, and
 * none should be added without a fresh review.
 */

import {
  requireBoundedText,
  requireClosedObject,
  requireEnum,
  requireNanoid21,
  requireNonemptyString,
  requireNonNegativeInt64String,
  requireTimestampString,
  type Tokens,
} from "../contracts/common";
import { fail } from "../contracts/errors";
import {
  hasOnlyPairedSurrogates,
  parseStrictBytes,
  type JcsObject,
  type JcsValue,
} from "../contracts/jcs";
import {
  normalizeTarget,
  TARGET_KINDS,
  type TargetKind,
} from "../contracts/evidence-v1";
import { failPublication } from "./errors";
import { microsToTimestamp } from "./rows";

const MAX_REQUEST_BYTES = 1048576;
const MAX_REQUEST_DEPTH = 64;
const MAX_NAME_BYTES = 256;
const MAX_QUERY_BYTES = 8192;
const MAX_SHORT_TEXT_BYTES = 256;
const MAX_LONG_TEXT_BYTES = 65536;
const MAX_REF_BYTES = 2048;

/** Hits per createTrace call. Nonempty is NOT required: a trace may start
 *  with zero hits and gain none later, since hits are immutable and there is
 *  no append-hits method in v1. */
export const MAX_HITS = 256;
/** Page size ceiling for listTraceHits. A small JSON integer, NOT an Int64. */
export const MAX_PAGE_LIMIT = 200;

/** No enum is declared in the physical schema for `status`; this module
 *  defines the closed set the request grammar and the stored codec both use. */
export const TRACE_STATUSES = ["open", "complete", "abandoned"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

/** The exact physical field order of a stored `traces` row. */
export const TRACE_FIELDS = [
  "id",
  "name",
  "workspace_name",
  "session_name",
  "peer_name",
  "query",
  "mode",
  "session_id",
  "session_from_ts",
  "session_to_ts",
  "friction_score",
  "confidence",
  "parent_id",
  "prev_id",
  "depth",
  "status",
  "h_metadata",
  "internal_metadata",
  "created_at",
  "updated_at",
] as const;

/** The exact physical field order of a stored `trace_hits` row. There is NO
 *  `id` column: the only key is (workspace_name, trace_id, position). */
export const TRACE_HIT_FIELDS = [
  "workspace_name",
  "trace_id",
  "kind",
  "ref",
  "target",
  "line_start",
  "line_end",
  "excerpt",
  "content_hash",
  "captured_at",
  "note",
  "position",
] as const;

/* ------------------------------------------------------------------ *
 * Request grammar.
 * ------------------------------------------------------------------ */

const CREATE_TRACE_KEYS = [
  "workspace_name",
  "id",
  "name",
  "session_name",
  "peer_name",
  "query",
  "mode",
  "session_id",
  "session_from_ts",
  "session_to_ts",
  "friction_score",
  "confidence",
  "parent_id",
  "prev_id",
  "depth",
  "status",
  "h_metadata",
  "internal_metadata",
  "hits",
] as const;

const CREATE_HIT_KEYS = [
  "kind",
  "target",
  "ref",
  "line_start",
  "line_end",
  "excerpt",
  "content_hash",
  "captured_at",
  "note",
] as const;

const GET_TRACE_KEYS = ["workspace_name", "id"] as const;
const LIST_TRACE_HITS_KEYS = ["workspace_name", "trace_id", "after_position", "limit"] as const;

/**
 * One caller-supplied hit, PRE-write. `position` is deliberately absent from
 * this shape: the physical position of a hit is its index in the `hits`
 * array of the SAME createTrace request, assigned by this module, so it is
 * contiguous 0..n-1 by construction rather than by a separate check of a
 * caller-supplied number that could disagree with the array order.
 */
export type CreateTraceHitInput = {
  kind: TargetKind;
  /** The RAW target value, not yet normalized. Normalization happens against
   *  the trace's own workspace_name at write time, in `service.ts`, because
   *  the target_key domain includes workspace_name and this module has no
   *  authority to assume which workspace a request will finally land in
   *  before the full request is parsed. */
  target: JcsValue;
  /** A caller-supplied OPAQUE locator string: where, within or alongside the
   *  resolved target, this hit points -- e.g. a byte offset spelling, a
   *  search-result rank, a citation label, or a fragment identifier. It is
   *  never dereferenced, never verified and never network-fetched by this
   *  kernel; it is a passive annotation for a later reader to interpret. */
  ref: string;
  line_start: string | null;
  line_end: string | null;
  excerpt: string | null;
  content_hash: string | null;
  /** Exact UTC-ms wire timestamp text, or null. Converted to STORAGE
   *  MICROSECONDS via the accepted `./rows` helper -- this column really is
   *  micros, unlike every timestamp on the trace row itself. */
  captured_at: string | null;
  note: string | null;
};

export type CreateTraceRequest = {
  workspace_name: string;
  id: string;
  name: string;
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
  status: TraceStatus;
  h_metadata: string | null;
  internal_metadata: string | null;
  hits: CreateTraceHitInput[];
};

export type GetTraceRequest = { workspace_name: string; id: string };

export type ListTraceHitsRequest = {
  workspace_name: string;
  trace_id: string;
  after_position: string | null;
  limit: number;
};

function parseRequest(bytes: Uint8Array, tokens: Tokens = []): JcsObject {
  if (!(bytes instanceof Uint8Array)) {
    fail("invalid_type", tokens, "expected request bytes");
  }
  const parsed = parseStrictBytes(bytes, tokens, {
    maxBytes: MAX_REQUEST_BYTES,
    maxDepth: MAX_REQUEST_DEPTH,
  });
  if (!(parsed instanceof Map)) fail("invalid_type", tokens, "expected object");
  return parsed as JcsObject;
}

function name(value: JcsValue | undefined, tokens: Tokens): string {
  return requireBoundedText(requireNonemptyString(value ?? null, tokens), MAX_NAME_BYTES, tokens);
}

function nullableShortText(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireBoundedText(requireNonemptyString(v, tokens), MAX_SHORT_TEXT_BYTES, tokens);
}

function nullableLongText(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireBoundedText(requireNonemptyString(v, tokens), MAX_LONG_TEXT_BYTES, tokens);
}

function nullableOpaqueText(value: JcsValue | undefined, tokens: Tokens): string | null {
  // h_metadata / internal_metadata carry opaque JSON documents. No invented
  // bound beyond the whole-request byte cap: inventing a per-field ceiling
  // here would be a new rule this module has no contract basis for.
  const v = value ?? null;
  if (v === null) return null;
  if (typeof v !== "string") fail("invalid_type", tokens, "expected string");
  if (!hasOnlyPairedSurrogates(v)) fail("invalid_unicode", tokens, "unpaired surrogate");
  return v;
}

/**
 * Both `session_from_ts`/`session_to_ts` (millisecond storage) and
 * `captured_at` (microsecond storage) share the SAME wire grammar: exact
 * UTC-ms text, years 1..9999. `requireTimestampString` (-> `v1.parseTimestamp`)
 * is the ACCEPTED governed check for that grammar and, critically, rejects a
 * leading "0000" year that the length+regex+round-trip checks in this
 * module's own `timestampToMillis` and `./rows`' `timestampToMicros` do NOT
 * reject on their own -- those two converters check SHAPE, not the calendar
 * floor. Validating through the governed helper HERE, before either
 * unit-specific converter ever runs, is what keeps a year-0000 value from
 * reaching a write at all: it fails invalid_value at the FIELD POINTER,
 * never integrity_failure at root, and never inside the post-write window.
 */
function nullableTimestamp(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireTimestampString(v, tokens);
}

function nullableCapturedAt(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireTimestampString(v, tokens);
}

function nullableFriction(value: JcsValue | undefined, tokens: Tokens): number | null {
  const v = value ?? null;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    // NaN and Infinity have no JSON spelling and are refused, not coerced.
    fail("invalid_value", tokens, "expected a finite JSON number");
  }
  return v;
}

function nullablePointer(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireNanoid21(v, tokens);
}

function nullableInt64Text(value: JcsValue | undefined, tokens: Tokens): string | null {
  const v = value ?? null;
  if (v === null) return null;
  return requireNonNegativeInt64String(v, tokens).text;
}

function targetKind(value: JcsValue | undefined, tokens: Tokens): TargetKind {
  return requireEnum(value ?? null, TARGET_KINDS, tokens);
}

function parseHit(value: JcsValue, tokens: Tokens): CreateTraceHitInput {
  const o = requireClosedObject(value, CREATE_HIT_KEYS, tokens);
  const kind = targetKind(o.get("kind"), [...tokens, "kind"]);
  const target = o.get("target") ?? null;
  if (target === null) fail("missing_field", [...tokens, "target"], "target is required");
  // Structural + per-kind normalization happens here, EAGERLY, so a malformed
  // target is refused at parse time rather than deep inside a queued write.
  // The result is discarded; `service.ts` re-derives the canonical text
  // against the trace's resolved workspace_name, which this module does not
  // itself decide.
  normalizeTarget(kind, target, [...tokens, "target"]);
  return {
    kind,
    target,
    ref: requireBoundedText(requireNonemptyString(o.get("ref") ?? null, [...tokens, "ref"]), MAX_REF_BYTES, [
      ...tokens,
      "ref",
    ]),
    line_start: nullableInt64Text(o.get("line_start"), [...tokens, "line_start"]),
    line_end: nullableInt64Text(o.get("line_end"), [...tokens, "line_end"]),
    excerpt: nullableLongText(o.get("excerpt"), [...tokens, "excerpt"]),
    content_hash: nullableShortText(o.get("content_hash"), [...tokens, "content_hash"]),
    captured_at: nullableCapturedAt(o.get("captured_at"), [...tokens, "captured_at"]),
    note: nullableLongText(o.get("note"), [...tokens, "note"]),
  };
}

export function parseCreateTrace(bytes: Uint8Array): CreateTraceRequest {
  const request = requireClosedObject(parseRequest(bytes), CREATE_TRACE_KEYS, []);
  const rawHits = request.get("hits");
  if (!Array.isArray(rawHits)) fail("invalid_type", ["hits"], "expected array");
  if (rawHits.length > MAX_HITS) fail("limit_exceeded", ["hits"], `at most ${MAX_HITS} hits`);
  const hits = rawHits.map((h, i) => parseHit(h, ["hits", i]));
  // Contiguous 0..n-1 is an INVARIANT of "position = array index", proven by
  // construction: this loop cannot produce anything else. Stated explicitly
  // because the physical column is defined that way, not because the
  // invariant could fail here.
  hits.forEach((_, i) => {
    if (i < 0 || i >= hits.length) failPublication("integrity_failure", "");
  });

  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    id: requireNanoid21(request.get("id") ?? null, ["id"]),
    name: requireBoundedText(
      requireNonemptyString(request.get("name") ?? null, ["name"]),
      MAX_SHORT_TEXT_BYTES,
      ["name"],
    ),
    session_name: nullableShortText(request.get("session_name"), ["session_name"]),
    peer_name: nullableShortText(request.get("peer_name"), ["peer_name"]),
    query: requireBoundedText(requireNonemptyString(request.get("query") ?? null, ["query"]), MAX_QUERY_BYTES, [
      "query",
    ]),
    mode: nullableShortText(request.get("mode"), ["mode"]),
    session_id: nullableShortText(request.get("session_id"), ["session_id"]),
    session_from_ts: nullableTimestamp(request.get("session_from_ts"), ["session_from_ts"]),
    session_to_ts: nullableTimestamp(request.get("session_to_ts"), ["session_to_ts"]),
    friction_score: nullableFriction(request.get("friction_score"), ["friction_score"]),
    confidence: nullableShortText(request.get("confidence"), ["confidence"]),
    parent_id: nullablePointer(request.get("parent_id"), ["parent_id"]),
    prev_id: nullablePointer(request.get("prev_id"), ["prev_id"]),
    depth: requireNonNegativeInt64String(request.get("depth") ?? null, ["depth"]).text,
    status: requireEnum(request.get("status") ?? null, TRACE_STATUSES, ["status"]),
    h_metadata: nullableOpaqueText(request.get("h_metadata"), ["h_metadata"]),
    internal_metadata: nullableOpaqueText(request.get("internal_metadata"), ["internal_metadata"]),
    hits,
  };
}

export function parseGetTrace(bytes: Uint8Array): GetTraceRequest {
  const request = requireClosedObject(parseRequest(bytes), GET_TRACE_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    id: requireNanoid21(request.get("id") ?? null, ["id"]),
  };
}

export function parseListTraceHits(bytes: Uint8Array): ListTraceHitsRequest {
  const request = requireClosedObject(parseRequest(bytes), LIST_TRACE_HITS_KEYS, []);
  const rawLimit = request.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("out_of_range", ["limit"], `limit must be an integer in [1, ${MAX_PAGE_LIMIT}]`);
  }
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    trace_id: requireNanoid21(request.get("trace_id") ?? null, ["trace_id"]),
    after_position: nullableInt64Text(request.get("after_position"), ["after_position"]),
    limit: rawLimit,
  };
}

/* ------------------------------------------------------------------ *
 * Stored row codec. Stored-state faults are integrity_failure at ROOT.
 * ------------------------------------------------------------------ */

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

function storedText(value: unknown): string {
  if (typeof value !== "string") failPublication("integrity_failure", "");
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure", "");
  return value;
}

function storedNullableText(value: unknown): string | null {
  if (value === null) return null;
  return storedText(value);
}

function storedNonemptyText(value: unknown): string {
  const text = storedText(value);
  if (text.length === 0) failPublication("integrity_failure", "");
  return text;
}

function storedNullableNonemptyText(value: unknown): string | null {
  if (value === null) return null;
  return storedNonemptyText(value);
}

function storedStatus(value: unknown): TraceStatus {
  const text = storedNonemptyText(value);
  if (!(TRACE_STATUSES as readonly string[]).includes(text)) failPublication("integrity_failure", "");
  return text as TraceStatus;
}

function storedTargetKind(value: unknown): TargetKind {
  const text = storedNonemptyText(value);
  if (!(TARGET_KINDS as readonly string[]).includes(text)) failPublication("integrity_failure", "");
  return text as TargetKind;
}

/** RAW int64 (bigint or safe-integer number) to canonical decimal TEXT. */
function storedInt64Text(value: unknown): string {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return BigInt(value).toString(10);
  }
  return failPublication("integrity_failure", "");
}

function storedNullableInt64Text(value: unknown): string | null {
  if (value === null) return null;
  return storedInt64Text(value);
}

function storedFloat64OrNull(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number") failPublication("integrity_failure", "");
  // A stored NaN or Infinity has no JSON spelling; refused, never coerced to
  // null or to a sentinel number.
  if (!Number.isFinite(value)) failPublication("integrity_failure", "");
  return value;
}

/* ---- Millisecond converters, ONLY for the four `traces` timestamp columns.
 * Deliberately NOT the `./rows` micros helpers -- see the unit-trap comment
 * at the top of this file. Gregorian bounds are the same accepted ones
 * `./rows` uses internally; duplicated here because that module does not
 * export them, and importing a private constant is not an option. */

const MIN_EPOCH_MS = -62135596800000n;
const MAX_EPOCH_MS = 253402300799999n;

/** RAW storage milliseconds to an exact UTC millisecond wire string. */
export function millisToTimestamp(millis: bigint): string {
  if (millis < MIN_EPOCH_MS || millis > MAX_EPOCH_MS) failPublication("integrity_failure", "");
  const text = new Date(Number(millis)).toISOString();
  if (Date.parse(text) !== Number(millis)) failPublication("integrity_failure", "");
  return text;
}

/** Exact UTC millisecond wire string to RAW storage milliseconds. Throws the
 *  GOVERNED `ContractError` (via `fail`), not `PublicationError`: this is
 *  used from the request grammar as well as from the stored-row codec, and
 *  the caller decides which envelope applies. */
export function timestampToMillis(text: unknown, tokens: Tokens = []): bigint {
  if (typeof text !== "string" || text.length !== 24) {
    fail("invalid_type", tokens, "expected exact UTC-ms timestamp text");
  }
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(text)) {
    fail("invalid_value", tokens, "expected exact UTC-ms timestamp text");
  }
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) fail("invalid_value", tokens, "timestamp does not parse");
  const parsed = new Date(millis);
  if (parsed.toISOString() !== text) fail("invalid_value", tokens, "timestamp is not canonical");
  const value = BigInt(millis);
  // DEFENSE IN DEPTH, not the only guard: `requireTimestampString` at the
  // request-grammar call site (`nullableTimestamp`) already rejects a
  // leading "0000" year via `v1.parseTimestamp`. This second, independent
  // check is what stops a DIRECT caller of this exported converter --
  // shape+round-trip alone accepts "0000-06-15T12:00:00.000Z" (Date.parse
  // round-trips it identically), which is BELOW MIN_EPOCH_MS. Governed
  // invalid_value at the field pointer, never integrity_failure at root.
  if (value < MIN_EPOCH_MS || value > MAX_EPOCH_MS) {
    fail("invalid_value", tokens, "timestamp must be within years 1..9999");
  }
  return value;
}

/** RAW storage milliseconds (bigint or safe-integer number), required. */
function storedMillisTimestamp(value: unknown): string {
  if (typeof value === "bigint") return millisToTimestamp(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return millisToTimestamp(BigInt(value));
  }
  return failPublication("integrity_failure", "");
}

function storedNullableMillisTimestamp(value: unknown): string | null {
  if (value === null) return null;
  return storedMillisTimestamp(value);
}

/** RAW storage MICROSECONDS (bigint or safe-integer number), nullable. This
 *  is the ONLY place in this module that touches `./rows`' micros helpers,
 *  and it is used for `trace_hits.captured_at` exclusively. */
function storedMicrosTimestampOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "bigint") return microsToTimestamp(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return microsToTimestamp(BigInt(value));
  }
  return failPublication("integrity_failure", "");
}

/** One stored `traces` row to its exact 20 wire fields, in physical order. */
export function encodeTraceRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, TRACE_FIELDS);
  return {
    id: storedNonemptyText(row.id),
    name: storedNonemptyText(row.name),
    workspace_name: storedNonemptyText(row.workspace_name),
    session_name: storedNullableNonemptyText(row.session_name),
    peer_name: storedNullableNonemptyText(row.peer_name),
    query: storedNonemptyText(row.query),
    mode: storedNullableText(row.mode),
    session_id: storedNullableText(row.session_id),
    // Raw MILLISECONDS. NOT the ./rows micros helper -- see file header.
    session_from_ts: storedNullableMillisTimestamp(row.session_from_ts),
    session_to_ts: storedNullableMillisTimestamp(row.session_to_ts),
    friction_score: storedFloat64OrNull(row.friction_score),
    confidence: storedNullableText(row.confidence),
    parent_id: storedNullableNonemptyText(row.parent_id),
    prev_id: storedNullableNonemptyText(row.prev_id),
    depth: storedInt64Text(row.depth),
    status: storedStatus(row.status),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    // Raw MILLISECONDS, required. Immutability (`updated_at === created_at`
    // on a FRESH write) is asserted by the caller on readback, not here: an
    // imported legacy row may legitimately differ, and this codec has no way
    // to distinguish "just created" from "imported" by row shape alone.
    created_at: storedMillisTimestamp(row.created_at),
    updated_at: storedMillisTimestamp(row.updated_at),
  };
}

/** One stored `trace_hits` row to its exact 12 wire fields, in physical
 *  order. `target` is passed through as its stored canonical JSON TEXT:
 *  re-parsing it into a nested object here would invent a shape the wire
 *  contract does not define for a read path. */
export function encodeTraceHitRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, TRACE_HIT_FIELDS);
  return {
    workspace_name: storedNonemptyText(row.workspace_name),
    trace_id: storedNonemptyText(row.trace_id),
    kind: storedTargetKind(row.kind),
    ref: storedNonemptyText(row.ref),
    target: storedNonemptyText(row.target),
    line_start: storedNullableInt64Text(row.line_start),
    line_end: storedNullableInt64Text(row.line_end),
    excerpt: storedNullableText(row.excerpt),
    content_hash: storedNullableText(row.content_hash),
    // Raw MICROSECONDS -- the ONE column in this whole kernel that really is
    // micros. Everything else on the trace row is milliseconds.
    captured_at: storedMicrosTimestampOrNull(row.captured_at),
    note: storedNullableText(row.note),
    position: storedInt64Text(row.position),
  };
}
