/**
 * #30 search chunks -- the PURE half.
 *
 * Request grammar and the stored-row codec for `search_chunks_v1`, with no
 * SDK, connection or owner import. Everything here is decidable from bytes
 * alone, modelled on `read-cursor.ts`.
 *
 * Two physical facts drive this module, both measured against the live
 * schema rather than assumed:
 *
 * 1. `embedding` is `fixed_size_list<float32?>[384]`. The dimension is FROZEN
 *    by the column type itself -- a profile declaring any other dimension
 *    cannot be stored, so it is refused here, at the boundary, before a
 *    caller ever reaches the writer.
 * 2. `status` is `utf8 NOT NULL` with no enum in the physical schema. The
 *    closed set below is this module's own decision, not a stored constraint
 *    -- a differently-configured writer could legally store a fourth value,
 *    which is why the stored codec's status check is integrity_failure, not
 *    a request-grammar rejection.
 */

import {
  requireBoundedText,
  requireClosedObject,
  requireNanoid21,
  requireNonemptyString,
  sha256HexWithDomain,
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

/** The physical embedding dimension. Frozen by the column type: see header. */
export const EMBEDDING_DIMENSION = 384;

/** The one deterministic chunker this slice implements. */
export const CHUNKER_VERSION = "chunker/v1";
/** Fixed chunk size, measured in UTF-16 code units. Simple and deterministic. */
export const CHUNK_SIZE_CHARS = 1000;

/**
 * The closed status set. NOT a stored enum -- see header. `pending` is the
 * only value this module's own writer ever produces; `ready` and `failed`
 * are reserved for the (not-yet-implemented) embed step and are validated
 * here so a future writer and this reader agree on the vocabulary.
 */
export const CHUNK_STATUSES = ["pending", "ready", "failed"] as const;
export type ChunkStatus = (typeof CHUNK_STATUSES)[number];

/** Bounded sweep limit for reconciliation. See `parseReconcileSearch`. */
export const MAX_RECONCILE_REVISIONS = 1024;

/** The exact physical field order of a stored search-chunk row. */
export const SEARCH_CHUNK_FIELDS = [
  "id",
  "workspace_name",
  "node_id",
  "revision_id",
  "chunk_index",
  "text",
  "content_hash",
  "chunker_version",
  "embedding_profile",
  "embedding",
  "type_term_id",
  "term_ids",
  "observer_peer_name",
  "subject_peer_name",
  "session_name",
  "status",
  "attempts",
  "last_attempt_at",
  "embedded_at",
  "error_code",
] as const;

const INDEX_KEYS = [
  "workspace_name",
  "node_id",
  "revision_id",
  "chunker_version",
  "embedding_profile",
] as const;
const RECONCILE_KEYS = ["workspace_name", "limit"] as const;
// scoped on the SAME tuple the chunk id is keyed on: `indexRevisionChunks` is
// explicitly re-callable for one revision under different chunker versions
// and embedding profiles, and a list that did not scope on both would merge
// rows from unrelated indexing runs under one non-unique `chunk_index`.
const LIST_KEYS = ["workspace_name", "revision_id", "chunker_version", "embedding_profile"] as const;
const EMBEDDING_PROFILE_KEYS = ["name", "dims"] as const;

export type EmbeddingProfileRequest = { name: string; dims: number };

export type IndexRevisionChunksRequest = {
  workspace_name: string;
  node_id: string;
  revision_id: string;
  chunker_version: string;
  embedding_profile: EmbeddingProfileRequest;
};

export type ReconcileSearchChunksRequest = {
  workspace_name: string;
  limit: number;
};

export type ListChunksRequest = {
  workspace_name: string;
  revision_id: string;
  chunker_version: string;
  embedding_profile: string;
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

/** The declared namespace for node and revision ids is nanoid21. */
function nanoidField(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNanoid21(value ?? null, tokens);
}

/**
 * `dims` is validated and then DROPPED: only `name` becomes the stored
 * `embedding_profile` text. The frozen dimension is a fact about the ONE
 * physical column, not a per-row value the schema has anywhere to hold.
 */
function embeddingProfile(value: JcsValue | undefined, tokens: Tokens): EmbeddingProfileRequest {
  const object = requireClosedObject(value ?? null, EMBEDDING_PROFILE_KEYS, tokens);
  const profileName = name(object.get("name"), [...tokens, "name"]);
  const rawDims = object.get("dims");
  if (typeof rawDims !== "number" || !Number.isInteger(rawDims)) {
    fail("invalid_type", [...tokens, "dims"], "expected integer");
  }
  if (rawDims !== EMBEDDING_DIMENSION) {
    fail(
      "invalid_value",
      [...tokens, "dims"],
      `embedding dimension is frozen at ${EMBEDDING_DIMENSION}`,
    );
  }
  return { name: profileName, dims: rawDims };
}

/**
 * The ONLY implemented chunker label. `chunker_version` is not free text: it
 * is a content-derived identity input (it keys both the chunk id and the
 * idempotency check), so an unvalidated string here would let a caller label
 * v1 output as `"chunker/v2"` -- a real v2 implementation would later derive
 * the SAME ids for that label and treat the v1 rows as already_satisfied,
 * forever. Rejecting anything but the one constant this module actually runs
 * keeps the label and the code that produced it in agreement.
 */
function chunkerVersion(value: JcsValue | undefined, tokens: Tokens): string {
  const text = name(value, tokens);
  if (text !== CHUNKER_VERSION) {
    fail("invalid_value", tokens, `expected ${JSON.stringify(CHUNKER_VERSION)}`);
  }
  return text;
}

export function parseIndexRevision(bytes: Uint8Array): IndexRevisionChunksRequest {
  const request = requireClosedObject(parseRequest(bytes), INDEX_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    node_id: nanoidField(request.get("node_id"), ["node_id"]),
    revision_id: nanoidField(request.get("revision_id"), ["revision_id"]),
    chunker_version: chunkerVersion(request.get("chunker_version"), ["chunker_version"]),
    embedding_profile: embeddingProfile(request.get("embedding_profile"), ["embedding_profile"]),
  };
}

/**
 * `limit` bounds a single bounded sweep. It is a small JSON integer, not an
 * Int64 wire field, deliberately capped at `MAX_RECONCILE_REVISIONS`: a
 * caller cannot ask this kernel to visit more than the bounded exception
 * documented on the reconcile writer permits.
 */
export function parseReconcileSearch(bytes: Uint8Array): ReconcileSearchChunksRequest {
  const request = requireClosedObject(parseRequest(bytes), RECONCILE_KEYS, []);
  const rawLimit = request.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_RECONCILE_REVISIONS) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_RECONCILE_REVISIONS}`);
  }
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    limit: rawLimit,
  };
}

export function parseListChunks(bytes: Uint8Array): ListChunksRequest {
  const request = requireClosedObject(parseRequest(bytes), LIST_KEYS, []);
  return {
    workspace_name: name(request.get("workspace_name"), ["workspace_name"]),
    revision_id: nanoidField(request.get("revision_id"), ["revision_id"]),
    chunker_version: chunkerVersion(request.get("chunker_version"), ["chunker_version"]),
    embedding_profile: name(request.get("embedding_profile"), ["embedding_profile"]),
  };
}

/* ------------------------------------------------------------------ *
 * Deterministic id and content derivation. Pure functions only: no
 * randomness, no clock, no I/O -- retrying the same index request always
 * proposes the same rows.
 * ------------------------------------------------------------------ */

/**
 * Domain string for the chunk-id digest. Versioned like every other digest
 * domain in this package, so a future change to the id derivation is a new
 * domain rather than a silent reinterpretation of old ids.
 */
export const SEARCH_CHUNK_ID_DOMAIN = "arra-search-chunk-id/v1";

/**
 * Deterministic chunk id: sha256 over (revision_id, chunker_version,
 * embedding_profile, chunk_index), domain-separated.
 *
 * This is the ENTIRE idempotency mechanism for re-indexing: retrying
 * `indexRevisionChunks` for the same (revision, chunker_version,
 * embedding_profile) proposes the identical ids, so a re-run is a no-op
 * against already-written rows without any operation journal.
 */
export function deriveChunkId(
  revisionId: string,
  chunkerVersion: string,
  embeddingProfileName: string,
  chunkIndex: bigint,
): string {
  const material = JSON.stringify([revisionId, chunkerVersion, embeddingProfileName, chunkIndex.toString(10)]);
  return sha256HexWithDomain(SEARCH_CHUNK_ID_DOMAIN, material);
}

/** Domain string for the per-chunk content digest. */
export const SEARCH_CHUNK_CONTENT_DOMAIN = "arra-search-chunk-content/v1";

export function deriveContentHash(text: string): string {
  return sha256HexWithDomain(SEARCH_CHUNK_CONTENT_DOMAIN, text);
}

/**
 * Fixed-size deterministic chunker, by UTF-16 code units -- EXCEPT that a
 * boundary is never allowed to land inside a surrogate pair.
 *
 * Simple and deterministic on purpose: this is not a semantic chunker, it is
 * the smallest thing that gives every revision a stable, reproducible set of
 * chunk boundaries so the same content always proposes the same chunks. An
 * empty string still produces exactly one (empty) chunk, so a revision with
 * empty derived text still gets one addressable row rather than none.
 *
 * A naive `slice(i, i + size)` can end exactly between a high surrogate and
 * its low surrogate (e.g. an emoji straddling a multiple of 1000). Both
 * halves are individually valid UTF-16 strings, so nothing downstream would
 * reject them at THIS boundary -- but the lone surrogate is not a valid
 * Unicode scalar, and the eventual UTF-8 encode silently replaces it with
 * U+FFFD, corrupting `text` and making `content_hash` (computed on the
 * pre-corruption string) permanently unreproducible from the stored bytes.
 * A split pair must simply never be produced: when the naive boundary would
 * fall on a high surrogate that has a following low surrogate, the boundary
 * is nudged one code unit forward so the pair stays intact in the earlier
 * chunk.
 */
export function chunkText(text: string, size: number = CHUNK_SIZE_CHARS): string[] {
  // `size` is an internal constant, never caller-supplied through a request:
  // a non-positive size would be a programming error in this module, not a
  // rejectable request, so it is asserted rather than mapped to a wire code.
  if (!Number.isInteger(size) || size <= 0) throw new Error("chunkText: size must be a positive integer");
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      // A high surrogate (0xD800-0xDBFF) at the very end of the slice means
      // the boundary split its pair -- the low surrogate is the next unit.
      if (code >= 0xd800 && code <= 0xdbff) end += 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/* ------------------------------------------------------------------ *
 * Stored row codec. Stored-state faults are integrity_failure at ROOT:
 * no request pointer names a row the caller never supplied.
 * ------------------------------------------------------------------ */

/**
 * EXACTLY these columns: present, own, and nothing else. Copied from
 * `read-cursor.ts` rather than imported, because a shared helper reaching
 * across two independent row shapes is how one slice's column list quietly
 * becomes the other's.
 */
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

/** Int64 physical column: decimal TEXT on the wire, matching `rows.ts`. */
function storedInt64Text(value: unknown): string {
  const asBigInt =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : failPublication("integrity_failure", "");
  if (asBigInt < -(2n ** 63n) || asBigInt > 2n ** 63n - 1n) failPublication("integrity_failure", "");
  return asBigInt.toString(10);
}

/** Raw microseconds to the exact wire millisecond string, or explicit null. */
function storedNullableTimestamp(value: unknown): string | null {
  // EXPLICIT null only. `undefined` in a present column is a malformed row,
  // and reading it as "no timestamp" would invent an absence the data never
  // stated -- the same distinction `read-cursor.ts`'s `storedPointer` draws.
  if (value === null) return null;
  if (typeof value === "bigint") return microsToTimestamp(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return microsToTimestamp(BigInt(value));
  }
  return failPublication("integrity_failure", "");
}

function storedStatus(value: unknown): ChunkStatus {
  if (typeof value !== "string" || !(CHUNK_STATUSES as readonly string[]).includes(value)) {
    failPublication("integrity_failure", "");
  }
  return value as ChunkStatus;
}

/**
 * `term_ids` is `list<utf8?> NOT NULL` -- the only list-typed column in the
 * whole schema. The list itself is required; each ELEMENT is nullable by the
 * physical type, though this writer never stores a null element.
 *
 * Accepts either a real JS array (the shape `decodeArrowRows` would need to
 * hand back for this to round-trip transparently) or an Arrow-list-like
 * object exposing `toArray()`, so the codec does not assume which one the
 * measured decode path actually produces.
 */
function storedTermIds(value: unknown): (string | null)[] {
  let items: unknown;
  if (Array.isArray(value)) {
    items = value;
  } else if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toArray?: unknown }).toArray === "function"
  ) {
    items = (value as { toArray(): unknown }).toArray();
  } else {
    return failPublication("integrity_failure", "");
  }
  if (!Array.isArray(items)) failPublication("integrity_failure", "");
  return items.map((item) => {
    // EXPLICIT null only -- see `storedNullableTimestamp`.
    if (item === null) return null;
    return storedText(item);
  });
}

/**
 * `embedding` is `fixed_size_list<float32?>[384]`, NULLABLE. Deliberately
 * accepted as null ONLY: this writer never populates it (embedding is off
 * the authoritative write path -- see the header), so this codec has no
 * authority to invent a float-array validation it never has to serve. A
 * populated column is refused rather than silently passed through, because
 * this module could not vouch for its shape.
 */
function storedEmbeddingMustBeNull(value: unknown): null {
  // EXPLICIT null only -- see `storedNullableTimestamp`. A present-but-
  // `undefined` embedding column is a malformed row, not "not yet embedded".
  if (value !== null) failPublication("integrity_failure", "");
  return null;
}

/**
 * One stored row to its wire fields, in physical order minus `embedding`.
 *
 * `embedding` is DELIBERATELY OMITTED from the returned object rather than
 * emitted as `null`: the instruction is "omitted or null on the wire", and
 * omission is the cheaper, unambiguous choice -- a caller checking `"embedding"
 * in row` gets a real answer instead of one that depends on which sender it
 * saw.
 */
export function encodeSearchChunkRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, SEARCH_CHUNK_FIELDS);
  // Validated for shape even though it is not emitted: a corrupt embedding
  // column is still stored corruption, whether or not the wire ever shows it.
  storedEmbeddingMustBeNull(row.embedding);
  return {
    id: storedText(row.id),
    workspace_name: storedText(row.workspace_name),
    node_id: storedText(row.node_id),
    revision_id: storedText(row.revision_id),
    chunk_index: storedInt64Text(row.chunk_index),
    text: storedText(row.text),
    content_hash: storedText(row.content_hash),
    chunker_version: storedText(row.chunker_version),
    embedding_profile: storedText(row.embedding_profile),
    type_term_id: storedText(row.type_term_id),
    term_ids: storedTermIds(row.term_ids),
    observer_peer_name: storedNullableText(row.observer_peer_name),
    subject_peer_name: storedNullableText(row.subject_peer_name),
    session_name: storedNullableText(row.session_name),
    status: storedStatus(row.status),
    attempts: storedInt64Text(row.attempts),
    last_attempt_at: storedNullableTimestamp(row.last_attempt_at),
    embedded_at: storedNullableTimestamp(row.embedded_at),
    error_code: storedNullableText(row.error_code),
  };
}
