/**
 * Session links v1 -- the PURE half.
 *
 * Contract: app/docs/contracts/session-link-v1.md
 * SHA256 9a0235d7279d3a8ee56bbb83aac70b2eb769db507b24e591bf7ef80e024c6784
 * (Soul-Brews-Studio/arra-oracle-v4#28)
 *
 * Request grammar and the stored-row codec, with no SDK, connection or owner
 * import. Everything here is decidable from bytes alone.
 *
 * TWO envelopes, neither new:
 *   - governed ContractError / arra-error/v1 for parse, shape and value.
 *   - PublicationError / arra-publication-error/v1 for STORED-state failures,
 *     always at the ROOT path (`""`).
 */

import {
  requireBoundedText,
  requireClosedObject,
  requireEnum,
  requireNanoid21,
  requireNonemptyString,
  type Tokens,
} from "../contracts/common";
import { fail, ContractError } from "../contracts/errors";
import { normalizeTarget, requireTargetKind } from "../contracts/evidence-v1";
import {
  canonicalize,
  hasOnlyPairedSurrogates,
  obj,
  parseStrict,
  parseStrictBytes,
  type JcsObject,
  type JcsValue,
} from "../contracts/jcs";
import { failPublication } from "./errors";
import { microsToTimestamp } from "./rows";

const MAX_REQUEST_BYTES = 1048576;
const MAX_REQUEST_DEPTH = 64;
const MAX_NAME_BYTES = 256;

export const MAX_PAGE_LIMIT = 100;
export const MAX_RESULT_WIRE_BYTES = 16 * 1024 * 1024;
/** Bounded reverse-walk visited-set for the directed-relation cycle check. */
export const MAX_CYCLE_VISITED = 1024;

/** Exactly the eight physical columns, in physical order. */
export const SESSION_LINK_FIELDS = [
  "id",
  "workspace_name",
  "from_session_name",
  "to_session_name",
  "relation",
  "evidence_ref",
  "created_by_peer_name",
  "created_at",
] as const;

export const SESSION_RELATIONS = ["continues", "forked_from", "related_to"] as const;
export type SessionRelation = (typeof SESSION_RELATIONS)[number];

export const SESSION_LINK_DIRECTIONS = ["from", "to"] as const;
export type SessionLinkDirection = (typeof SESSION_LINK_DIRECTIONS)[number];

const CREATE_KEYS = [
  "id",
  "workspace_name",
  "from_session_name",
  "to_session_name",
  "relation",
  "evidence_ref",
  "created_by_peer_name",
] as const;

const LIST_KEYS = ["workspace_name", "session_name", "direction", "cursor", "limit"] as const;

const EVIDENCE_REF_KEYS = ["target_kind", "target"] as const;

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
  const v = value ?? null;
  return v === null ? null : name(v, tokens);
}

function id(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNanoid21(value ?? null, tokens);
}

function relation(value: JcsValue | undefined, tokens: Tokens): SessionRelation {
  return requireEnum(value ?? null, SESSION_RELATIONS, tokens);
}

/**
 * `evidence_ref` op: normalize `{target_kind, target}` through the ACCEPTED
 * evidence codec (the same one association's link targets use -- no invented
 * `target_key` column, none exists on `session_links`) and canonicalize the
 * WHOLE wrapper into one canonical JSON text. That text is the entire wire
 * representation, both stored and compared on replay.
 *
 * EXPLICIT null means no evidence attached; omission is `missing_field` --
 * requireClosedObject already enforces that the key is present.
 */
function evidenceRefText(value: JcsValue | undefined, tokens: Tokens): string | null {
  const raw = value ?? null;
  if (raw === null) return null;
  const o = requireClosedObject(raw, EVIDENCE_REF_KEYS, tokens);
  const kind = requireTargetKind(o.get("target_kind") ?? null, [...tokens, "target_kind"]);
  const normalized = normalizeTarget(kind, o.get("target") ?? null, [...tokens, "target"]);
  return canonicalize(obj({ target_kind: kind, target: normalized }), tokens);
}

export type CreateSessionLinkRequest = {
  id: string;
  workspace_name: string;
  from_session_name: string;
  to_session_name: string;
  relation: SessionRelation;
  evidence_ref: string | null;
  created_by_peer_name: string | null;
};

export function parseCreateSessionLink(bytes: Uint8Array): CreateSessionLinkRequest {
  const o = requireClosedObject(parseRequest(bytes), CREATE_KEYS, []);
  const fromSessionName = name(o.get("from_session_name"), ["from_session_name"]);
  const toSessionName = name(o.get("to_session_name"), ["to_session_name"]);
  // Self-link is decidable from the two names alone, so it is refused HERE,
  // by the parser, as a governed ContractError -- never inside the queued
  // turn, where a malformed request would become an owner event and would
  // report the wrong pointer ahead of reference/workspace resolution.
  if (fromSessionName === toSessionName) {
    fail("invalid_value", ["to_session_name"], "must not equal from_session_name");
  }
  return {
    id: id(o.get("id"), ["id"]),
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    from_session_name: fromSessionName,
    to_session_name: toSessionName,
    relation: relation(o.get("relation"), ["relation"]),
    evidence_ref: evidenceRefText(o.get("evidence_ref"), ["evidence_ref"]),
    created_by_peer_name: nullableName(o.get("created_by_peer_name"), ["created_by_peer_name"]),
  };
}

export type ListSessionLinksRequest = {
  workspace_name: string;
  session_name: string;
  direction: SessionLinkDirection;
  cursor: string | null;
  limit: number;
};

export function parseListSessionLinks(bytes: Uint8Array): ListSessionLinksRequest {
  const o = requireClosedObject(parseRequest(bytes), LIST_KEYS, []);
  const direction = requireEnum(o.get("direction") ?? null, SESSION_LINK_DIRECTIONS, ["direction"]);
  const rawCursor = o.get("cursor");
  const cursor = (rawCursor ?? null) === null ? null : id(rawCursor, ["cursor"]);

  const rawLimit = o.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_PAGE_LIMIT}`);
  }

  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    direction,
    cursor,
    limit: rawLimit,
  };
}

/* ------------------------------------------------------------------ *
 * Stored row codec. Stored-state faults are integrity_failure at ROOT:
 * no request pointer names a row the caller never supplied.
 * ------------------------------------------------------------------ */

/**
 * EXACTLY these columns: present, own, and nothing else.
 *
 * A malformed CONTAINER is refused before any field is read: an array or a
 * primitive is not a row, whatever it may happen to answer to. `in` walks the
 * prototype chain, so `Object.prototype.hasOwnProperty.call` is used rather
 * than a row's own (possibly shadowed) method.
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

/** Valid Unicode, through the ACCEPTED surrogate check. */
function storedText(value: unknown): string {
  if (typeof value !== "string") failPublication("integrity_failure", "");
  if (!hasOnlyPairedSurrogates(value)) failPublication("integrity_failure", "");
  return value;
}

function storedName(value: unknown): string {
  const text = storedText(value);
  if (text.length === 0) failPublication("integrity_failure", "");
  if (new TextEncoder().encode(text).length > MAX_NAME_BYTES) {
    failPublication("integrity_failure", "");
  }
  return text;
}

function storedNanoid21(value: unknown): string {
  const text = storedText(value);
  if (!/^[A-Za-z0-9_-]{21}$/.test(text)) failPublication("integrity_failure", "");
  return text;
}

function storedRelation(value: unknown): SessionRelation {
  const text = storedText(value);
  if (!(SESSION_RELATIONS as readonly string[]).includes(text)) {
    failPublication("integrity_failure", "");
  }
  return text as SessionRelation;
}

function storedNullableName(value: unknown): string | null {
  // EXPLICIT null only. `undefined` in a present column is a malformed row.
  if (value === null) return null;
  return storedName(value);
}

/**
 * A retained `evidence_ref` is the WHOLE canonical `{target_kind, target}`
 * wrapper, exactly as `evidenceRefText` produced it. Re-deriving and
 * re-canonicalizing proves the stored text is still exactly that shape;
 * anything else -- unparsable, wrong keys, an unknown kind, a non-canonical
 * byte sequence -- is stored corruption, not a request-side fault.
 */
function storedEvidenceRef(value: unknown): string | null {
  if (value === null) return null;
  const text = storedText(value);
  try {
    const parsed = parseStrict(text, []);
    if (!(parsed instanceof Map)) return failPublication("integrity_failure", "");
    const keys = Array.from(parsed.keys());
    if (keys.length !== EVIDENCE_REF_KEYS.length || !EVIDENCE_REF_KEYS.every((k) => parsed.has(k))) {
      return failPublication("integrity_failure", "");
    }
    const kind = requireTargetKind(parsed.get("target_kind") ?? null, ["target_kind"]);
    const normalized = normalizeTarget(kind, parsed.get("target") ?? null, ["target"]);
    const recanonicalized = canonicalize(obj({ target_kind: kind, target: normalized }), []);
    if (recanonicalized !== text) return failPublication("integrity_failure", "");
  } catch (error) {
    // ONLY a governed codec rejection means the stored text is corrupt. A
    // catch-all here would relabel a programming fault as stored corruption.
    if (!(error instanceof ContractError)) throw error;
    return failPublication("integrity_failure", "");
  }
  return text;
}

/**
 * RAW microseconds to the exact wire millisecond string. `created_at` is NOT
 * NULL on the physical schema, so a null here is stored corruption, never a
 * legitimate absence.
 */
function storedTimestamp(value: unknown): string {
  if (typeof value === "bigint") return microsToTimestamp(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failPublication("integrity_failure", "");
    return microsToTimestamp(BigInt(value));
  }
  return failPublication("integrity_failure", "");
}

/** One stored row to its exact eight wire fields, in physical order. */
export function encodeSessionLinkRow(row: Record<string, unknown>): Record<string, unknown> {
  requireExactColumns(row, SESSION_LINK_FIELDS);
  return {
    id: storedNanoid21(row.id),
    workspace_name: storedName(row.workspace_name),
    from_session_name: storedName(row.from_session_name),
    to_session_name: storedName(row.to_session_name),
    relation: storedRelation(row.relation),
    evidence_ref: storedEvidenceRef(row.evidence_ref),
    created_by_peer_name: storedNullableName(row.created_by_peer_name),
    created_at: storedTimestamp(row.created_at),
  };
}
