// Split out of session-link.ts (Nat style: one exported function per file).
// Contract: app/docs/contracts/session-link-v1.md
//
// Every helper below is used only by encodeSessionLinkRow, so all stay
// private to this file rather than getting their own single-export files.

import { ContractError } from "../contracts/errors";
import { normalizeTarget, requireTargetKind } from "../contracts/evidence-v1";
import { canonicalize, hasOnlyPairedSurrogates, obj, parseStrict } from "../contracts/jcs";
import { failPublication } from "./errors";
import { microsToTimestamp } from "./rows";
import {
  EVIDENCE_REF_KEYS,
  MAX_NAME_BYTES,
  SESSION_LINK_FIELDS,
  SESSION_RELATIONS,
  type SessionRelation,
} from "./session-link.constants";

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
 * legitimate absence. `bigint` ONLY (#105): a plain JS `number` here can only
 * be a lossy MILLISECOND read from the client's `toArray()`/`.get()`
 * accessor mistaken for microseconds -- see `context.rawMicros.ts` for the
 * full rationale.
 */
function storedTimestamp(value: unknown): string {
  if (typeof value === "bigint") return microsToTimestamp(value);
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
