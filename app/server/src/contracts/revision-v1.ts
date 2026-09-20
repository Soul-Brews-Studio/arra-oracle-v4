/**
 * Authoritative revision envelope, complete snapshots, and content digest —
 * candidate v1.
 *
 * The worker accepts a closed 21-key revision-content object whose JSON-valued
 * columns arrive as RAW TEXT. After strict parsing and normalization, the
 * HASHED logical envelope carries the same scalar keys with decoded `fields`
 * and metadata, and `terms`/`links` arrays replacing the two `*_snapshot_json`
 * keys. Nested JSON is hashed as values, never as double-encoded strings.
 *
 *   canonical_revision_bytes = UTF8(JCS(logical envelope))
 *   content_digest = sha256("arra-revision/v1\n" || canonical_revision_bytes)
 *
 * Physical `id`, `revision_no`, `operation_id`, `created_at`, the stored
 * `content_digest` and the node head are allocation/server state and are NOT
 * governed content — they are excluded at the adapter boundary, and this
 * closed payload rejects them as unexpected keys rather than silently
 * accepting them.
 *
 * This codec proves bytes and digests. It does not prove accepted ancestry,
 * valid references, authorization, publication, or that a snapshot's terms
 * exist in any live taxonomy.
 *
 * Contract: app/docs/contracts/revision-evidence-v1.md §3–4.
 */

import { fail } from "./errors";
import { canonicalize, type JcsObject, type JcsValue, LIMITS, obj, parseObjectText, parseStrict, utf8ByteLength } from "./jcs";
import {
  requireArray,
  requireBoolean,
  requireBoundedText,
  requireClosedObject,
  requireEnum,
  requireNanoid21,
  requireNonNegativeInt64String,
  requireNonemptyString,
  requireNullableNonemptyString,
  requireNullableString,
  requireNullableTimestampString,
  requireSha256Hex,
  requireUnicodeString,
  sha256HexWithDomain,
  type Tokens,
} from "./common";
import { normalizeTarget, requireTargetKind } from "./evidence-v1";

export const REVISION_DOMAIN = "arra-revision/v1\n";
export const CANONICAL_VERSION = "arra-revision/v1";
export const SCHEMA_VERSION = "1";

/** The 21 raw-column envelope keys, in documented order. */
export const ENVELOPE_KEYS = [
  "workspace_name", "node_id", "base_revision_id",
  "title", "body", "body_format", "fields",
  "author_peer_name", "observer_peer_name", "subject_peer_name", "session_name",
  "is_active", "valid_from", "valid_to", "change_reason",
  "schema_version", "canonical_version",
  "term_snapshot_json", "link_snapshot_json",
  "h_metadata", "internal_metadata",
] as const;

export const TERM_KEYS = ["term_id", "vocabulary_id", "vocabulary_name_snapshot", "term_name_snapshot", "label_snapshot", "position"] as const;
export const LINK_KEYS = ["position", "relation", "target_kind", "target", "excerpt", "content_hash", "captured_at", "capture_status", "note"] as const;
export const RELATIONS = ["supports", "contradicts", "derived_from", "discusses", "corrects", "related_to"] as const;
export const CAPTURE_STATUSES = ["captured", "locator_only", "unresolved"] as const;
export const BODY_FORMATS = ["markdown", "text"] as const;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

type Positioned = { position: bigint; entry: JcsObject };

/**
 * Enforce contiguous positions "0".."n-1", unique, then return entries sorted
 * by numeric position. Input order is irrelevant; the snapshot order is
 * defined by position alone.
 */
function orderByPosition(items: Positioned[], tokens: Tokens): JcsObject[] {
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    const key = item.position.toString();
    if (seen.has(key)) fail("snapshot_position", [...tokens, i, "position"], `duplicate position ${key}`);
    seen.add(key);
  }
  const sorted = [...items].sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  for (const [i, item] of sorted.entries()) {
    if (item.position !== BigInt(i)) {
      const originalIndex = items.indexOf(item);
      fail("snapshot_position", [...tokens, originalIndex, "position"], `positions must be exactly 0..${items.length - 1}; found ${item.position}`);
    }
  }
  return sorted.map((s) => s.entry);
}

export function normalizeTerms(value: JcsValue, tokens: Tokens): JcsObject[] {
  const arr = requireArray(value, tokens);
  const termIds = new Set<string>();
  const items: Positioned[] = arr.map((raw, i) => {
    const t = [...tokens, i];
    const o = requireClosedObject(raw, TERM_KEYS, t);
    const term_id = requireNanoid21(o.get("term_id")!, [...t, "term_id"]);
    if (termIds.has(term_id)) fail("invalid_value", [...t, "term_id"], "duplicate term_id in snapshot");
    termIds.add(term_id);
    const entry = obj({
      term_id,
      vocabulary_id: requireNanoid21(o.get("vocabulary_id")!, [...t, "vocabulary_id"]),
      vocabulary_name_snapshot: requireNonemptyString(o.get("vocabulary_name_snapshot")!, [...t, "vocabulary_name_snapshot"]),
      term_name_snapshot: requireNonemptyString(o.get("term_name_snapshot")!, [...t, "term_name_snapshot"]),
      label_snapshot: requireNullableString(o.get("label_snapshot")!, [...t, "label_snapshot"]),
      position: requireNonNegativeInt64String(o.get("position")!, [...t, "position"]).text,
    });
    return { position: BigInt(entry.get("position") as string), entry };
  });
  return orderByPosition(items, tokens);
}

export function normalizeLinks(value: JcsValue, tokens: Tokens): JcsObject[] {
  const arr = requireArray(value, tokens);
  const items: Positioned[] = arr.map((raw, i) => {
    const t = [...tokens, i];
    const o = requireClosedObject(raw, LINK_KEYS, t);
    const target_kind = requireTargetKind(o.get("target_kind")!, [...t, "target_kind"]);
    const entry = obj({
      position: requireNonNegativeInt64String(o.get("position")!, [...t, "position"]).text,
      relation: requireEnum(o.get("relation")!, RELATIONS, [...t, "relation"]),
      target_kind,
      target: normalizeTarget(target_kind, o.get("target")!, [...t, "target"]),
      excerpt: requireNullableString(o.get("excerpt")!, [...t, "excerpt"]),
      content_hash: o.get("content_hash") === null ? null : requireSha256Hex(o.get("content_hash")!, [...t, "content_hash"]),
      captured_at: requireNullableTimestampString(o.get("captured_at")!, [...t, "captured_at"]),
      capture_status: requireEnum(o.get("capture_status")!, CAPTURE_STATUSES, [...t, "capture_status"]),
      note: requireNullableString(o.get("note")!, [...t, "note"]),
    });
    return { position: BigInt(entry.get("position") as string), entry };
  });
  return orderByPosition(items, tokens);
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type RevisionColumns = {
  fields: string;
  term_snapshot_json: string;
  link_snapshot_json: string;
  h_metadata: string | null;
  internal_metadata: string | null;
};

export type RevisionResult = {
  canonical_json: string;
  content_digest: string;
  columns: RevisionColumns;
};

function parseBoundedObjectColumn(value: JcsValue, tokens: Tokens): JcsObject {
  const text = requireBoundedText(value, LIMITS.maxDocumentBytes, tokens);
  return parseObjectText(text, tokens);
}

function parseBoundedArrayColumn(value: JcsValue, tokens: Tokens): JcsValue {
  const text = requireBoundedText(value, LIMITS.maxDocumentBytes, tokens);
  return parseStrict(text, tokens);
}

/**
 * `revision` op. Validates the closed 21-key raw envelope, parses and
 * normalizes its JSON-valued columns, builds the logical envelope, and
 * returns canonical bytes, digest, and the normalized column texts that MUST
 * be what gets persisted — never the raw request strings.
 */
export function revisionOp(content: JcsValue, tokens: Tokens = []): RevisionResult {
  const o = requireClosedObject(content, ENVELOPE_KEYS, tokens);
  const t = (k: string): Tokens => [...tokens, k];
  const g = (k: string): JcsValue => o.get(k) as JcsValue;

  const workspace_name = requireNonemptyString(g("workspace_name"), t("workspace_name"));
  const node_id = requireNanoid21(g("node_id"), t("node_id"));
  const base_revision_id = g("base_revision_id") === null ? null : requireNanoid21(g("base_revision_id"), t("base_revision_id"));
  const title = requireUnicodeString(g("title"), t("title"));
  const body = requireUnicodeString(g("body"), t("body"));
  const body_format = requireEnum(g("body_format"), BODY_FORMATS, t("body_format"));
  const fields = parseBoundedObjectColumn(g("fields"), t("fields"));
  const author_peer_name = requireNullableNonemptyString(g("author_peer_name"), t("author_peer_name"));
  const observer_peer_name = requireNullableNonemptyString(g("observer_peer_name"), t("observer_peer_name"));
  const subject_peer_name = requireNullableNonemptyString(g("subject_peer_name"), t("subject_peer_name"));
  const session_name = requireNullableNonemptyString(g("session_name"), t("session_name"));
  const is_active = requireBoolean(g("is_active"), t("is_active"));
  const valid_from = requireNullableTimestampString(g("valid_from"), t("valid_from"));
  const valid_to = requireNullableTimestampString(g("valid_to"), t("valid_to"));
  const change_reason = requireNullableString(g("change_reason"), t("change_reason"));

  const schema_version = requireUnicodeString(g("schema_version"), t("schema_version"));
  if (schema_version !== SCHEMA_VERSION) fail("unsupported_version", t("schema_version"), `schema_version must be "${SCHEMA_VERSION}"`);
  const canonical_version = requireUnicodeString(g("canonical_version"), t("canonical_version"));
  if (canonical_version !== CANONICAL_VERSION) fail("unsupported_version", t("canonical_version"), `canonical_version must be "${CANONICAL_VERSION}"`);

  const terms = normalizeTerms(parseBoundedArrayColumn(g("term_snapshot_json"), t("term_snapshot_json")), t("term_snapshot_json"));
  const links = normalizeLinks(parseBoundedArrayColumn(g("link_snapshot_json"), t("link_snapshot_json")), t("link_snapshot_json"));
  const h_metadata = g("h_metadata") === null ? null : parseBoundedObjectColumn(g("h_metadata"), t("h_metadata"));
  const internal_metadata = g("internal_metadata") === null ? null : parseBoundedObjectColumn(g("internal_metadata"), t("internal_metadata"));

  // The hashed logical envelope: 21 keys, nested JSON as VALUES.
  const logical = obj({
    workspace_name, node_id, base_revision_id,
    title, body, body_format, fields,
    author_peer_name, observer_peer_name, subject_peer_name, session_name,
    is_active, valid_from, valid_to, change_reason,
    schema_version, canonical_version,
    terms, links,
    h_metadata, internal_metadata,
  });

  const canonical_json = canonicalize(logical, tokens);
  if (utf8ByteLength(canonical_json) > LIMITS.maxDocumentBytes) {
    fail("limit_exceeded", tokens, "canonical envelope exceeds the per-document limit");
  }
  const content_digest = sha256HexWithDomain(REVISION_DOMAIN, canonical_json);

  return {
    canonical_json,
    content_digest,
    columns: {
      fields: canonicalize(fields, t("fields")),
      term_snapshot_json: canonicalize(terms, t("term_snapshot_json")),
      link_snapshot_json: canonicalize(links, t("link_snapshot_json")),
      h_metadata: h_metadata === null ? null : canonicalize(h_metadata, t("h_metadata")),
      internal_metadata: internal_metadata === null ? null : canonicalize(internal_metadata, t("internal_metadata")),
    },
  };
}

/**
 * `verify_revision` op. The supplied content's JSON-valued columns must
 * ALREADY be canonical (this is a stored row, not a request), and the
 * recomputed digest must equal `content_digest`. Success attests validation
 * of the supplied bytes, not publication.
 */
export function verifyRevisionOp(content: JcsValue, contentDigest: JcsValue, tokens: Tokens = []): RevisionResult {
  const result = revisionOp(content, [...tokens, "content"]);
  const o = content as JcsObject;
  const columns: Array<keyof RevisionColumns> = ["fields", "term_snapshot_json", "link_snapshot_json", "h_metadata", "internal_metadata"];
  for (const k of columns) {
    if (o.get(k) !== result.columns[k]) fail("invalid_value", [...tokens, "content", k], "stored column is not canonical");
  }
  const supplied = requireSha256Hex(contentDigest, [...tokens, "content_digest"]);
  if (supplied !== result.content_digest) fail("digest_mismatch", [...tokens, "content_digest"], "content_digest does not match recomputed digest");
  return result;
}

/**
 * Derived projection rows from a NORMALIZED snapshot. Mechanical; no DB,
 * uniqueness, lookup, permission or reconciliation. Logical keys stay
 * (W, revision_id, term_id) and (W, revision_id, position).
 */
export function termProjection(workspaceName: string, revisionId: string, terms: JcsObject[]): JcsObject[] {
  return terms.map((term) => obj({
    workspace_name: workspaceName,
    revision_id: revisionId,
    term_id: term.get("term_id") as string,
    vocabulary_id: term.get("vocabulary_id") as string,
    vocabulary_name_snapshot: term.get("vocabulary_name_snapshot") as string,
    term_name_snapshot: term.get("term_name_snapshot") as string,
    label_snapshot: term.get("label_snapshot") as string | null,
    position: term.get("position") as string,
  }));
}
