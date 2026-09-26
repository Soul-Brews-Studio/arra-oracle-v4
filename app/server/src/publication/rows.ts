/**
 * Physical row <-> wire encoding for target Node and NodeRevision.
 *
 * Two rules drive everything here.
 *
 * First, Int64 columns never become JS numbers. `revision_no` and
 * `schema_version` are physical Int64, so they travel as canonical decimal
 * STRINGS and are held as BigInt in between. A Number would silently round
 * past 2^53 and there would be no error to notice.
 *
 * Second, timestamps are read from Arrow's RAW microsecond storage, never
 * through a row accessor. The accessor divides by 1000 into a lossy Number
 * before we can inspect it, so a sub-millisecond value would already be gone
 * by the time we looked. We check divisibility on the raw BigInt and refuse a
 * non-zero remainder rather than rounding it away.
 */

import { failPublication } from "./errors";

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
const INT64_REVISION_FIELDS = new Set<RevisionField>(["revision_no", "schema_version"]);
/** timestamp[us] columns, stored without timezone. */
const TIMESTAMP_REVISION_FIELDS = new Set<RevisionField>(["valid_from", "valid_to", "created_at"]);
const TIMESTAMP_NODE_FIELDS = new Set<NodeField>(["created_at", "updated_at"]);

const MICROS_PER_MILLI = 1000n;
/** Gregorian 0001-01-01 .. 9999-12-31T23:59:59.999 in epoch milliseconds. */
const MIN_EPOCH_MS = -62135596800000n;
const MAX_EPOCH_MS = 253402300799999n;

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

/** Canonical decimal text: no leading zeros, no plus sign, `0` for zero. */
const CANONICAL_INT64 = /^(?:0|-?[1-9][0-9]*)$/;

export function toInt64Text(value: bigint): string {
  if (value < INT64_MIN || value > INT64_MAX) failPublication("integrity_failure");
  return value.toString(10);
}

export function parseInt64Text(text: unknown): bigint {
  if (typeof text !== "string" || !CANONICAL_INT64.test(text)) failPublication("integrity_failure");
  const parsed = BigInt(text);
  if (parsed < INT64_MIN || parsed > INT64_MAX) failPublication("integrity_failure");
  return parsed;
}

/**
 * Convert raw storage microseconds to an exact UTC millisecond string.
 *
 * A non-zero remainder is refused, not rounded: the physical column can hold
 * microsecond precision this wire format cannot express, and silently
 * dropping it would make a lossy round trip look successful.
 */
export function microsToTimestamp(micros: bigint): string {
  if (micros % MICROS_PER_MILLI !== 0n) failPublication("integrity_failure");
  const millis = micros / MICROS_PER_MILLI;
  if (millis < MIN_EPOCH_MS || millis > MAX_EPOCH_MS) failPublication("integrity_failure");
  const text = new Date(Number(millis)).toISOString();
  // Round-trip guard: reject anything Date could not represent exactly.
  if (Date.parse(text) !== Number(millis)) failPublication("integrity_failure");
  return text;
}

/** Exact UTC millisecond string -> storage microseconds, with no float math. */
export function timestampToMicros(text: unknown): bigint {
  if (typeof text !== "string" || text.length !== 24) failPublication("integrity_failure");
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(text)) {
    failPublication("integrity_failure");
  }
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) failPublication("integrity_failure");
  const parsed = new Date(millis);
  if (parsed.toISOString() !== text) failPublication("integrity_failure");
  // Integer BigInt multiply: never `millis * 1000` in floating point.
  return BigInt(millis) * MICROS_PER_MILLI;
}

/**
 * Normalise one raw Arrow cell into a BigInt of microseconds. `bigint` ONLY.
 *
 * NO Date fallback, deliberately. A Date has ALREADY lost whatever
 * sub-millisecond precision the physical timestamp[us] column held, so
 * multiplying it back up by 1000 would manufacture a microsecond value and
 * present it as the stored one. Refusing forces the raw BigInt path, which
 * is the only source that can still prove exactness.
 *
 * NO `number` fallback either (#105): every legitimate raw microsecond value
 * reaches this function as a `bigint` (`decodeArrowRows`/`rawRows` read the
 * physical `BigInt64Array` directly; a freshly built row's timestamp field is
 * `BigInt(clock()) * 1000n`). A plain JS `number` here can only be a lossy
 * MILLISECOND read from the client's `toArray()`/`.get()` accessor mistaken
 * for microseconds, which would silently understate it 1000x instead of
 * failing closed.
 */
function rawMicros(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  return failPublication("integrity_failure");
}

function requireString(value: unknown): string {
  if (typeof value !== "string") failPublication("integrity_failure");
  return value;
}

function requireNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value);
}

/**
 * Encode one physical NodeRevision row for the wire.
 *
 * Exactly the 26 closed fields, in target physical-schema order. The five
 * JSON-valued columns stay as their stored canonical STRINGS -- re-parsing
 * them into nested objects would invent a shape the contract does not define
 * and would risk re-serialising different bytes than were digested.
 */
export function encodeRevisionRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of REVISION_FIELDS) {
    const value = row[field];
    if (INT64_REVISION_FIELDS.has(field)) {
      const asBigInt =
        typeof value === "bigint"
          ? value
          : typeof value === "number" && Number.isSafeInteger(value)
            ? BigInt(value)
            : failPublication("integrity_failure");
      out[field] = toInt64Text(asBigInt);
      continue;
    }
    if (TIMESTAMP_REVISION_FIELDS.has(field)) {
      if (value === null || value === undefined) {
        // created_at is NOT nullable in the physical schema.
        if (field === "created_at") failPublication("integrity_failure");
        out[field] = null;
        continue;
      }
      out[field] = microsToTimestamp(rawMicros(value));
      continue;
    }
    if (field === "is_active") {
      if (typeof value !== "boolean") failPublication("integrity_failure");
      out[field] = value;
      continue;
    }
    // Required text columns vs nullable ones.
    out[field] =
      field === "base_revision_id" ||
      field === "author_peer_name" ||
      field === "observer_peer_name" ||
      field === "subject_peer_name" ||
      field === "session_name" ||
      field === "change_reason" ||
      field === "h_metadata" ||
      field === "internal_metadata"
        ? requireNullableString(value)
        : requireString(value);
  }
  return out;
}

/** Encode one physical Node row: exactly the five columns, in schema order. */
export function encodeNodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of NODE_FIELDS) {
    const value = row[field];
    if (TIMESTAMP_NODE_FIELDS.has(field)) {
      if (value === null || value === undefined) failPublication("integrity_failure");
      out[field] = microsToTimestamp(rawMicros(value));
      continue;
    }
    out[field] = field === "current_revision_id" ? requireNullableString(value) : requireString(value);
  }
  return out;
}

/** UTF-8 byte length of a string, for the wire budget. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Wire byte cost of ONE encoded revision inside the `revisions` array.
 *
 * The budget counts the array only: `[]` is 2 bytes, each element adds its
 * compact JSON length, and every element after the first adds one comma. The
 * enclosing `{node,snapshot_head_revision_id,revisions}` object is excluded by
 * contract, so it is excluded here too.
 */
export const EMPTY_ARRAY_BYTES = 2;

export function revisionWireBytes(encoded: Record<string, unknown>): number {
  return utf8ByteLength(JSON.stringify(encoded));
}

/** 16 MiB exactly. Equality is ACCEPTED; only greater-than is rejected. */
export const MAX_CHAIN_WIRE_BYTES = 16 * 1024 * 1024;
/** At most 1024 rows of accepted ancestry per requested node. */
export const MAX_CHAIN_ROWS = 1024;
