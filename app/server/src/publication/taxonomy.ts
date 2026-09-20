/**
 * Taxonomy request grammar, bootstrap literals and physical row encoding.
 *
 * PURE by contract. This module must never import the storage SDK, and must
 * never acquire, retain or return an owner, adapter, connection or table.
 * Taxonomy persistence stays private in service.ts; everything here is
 * parsing, validation, encoding and errors, so it can be exercised without a
 * dataset and cannot become a back door to one.
 *
 * Contract: app/docs/contracts/taxonomy-write-v1.md
 */

import {
  requireBoolean,
  requireBoundedText,
  requireClosedObject,
  requireEnum,
  requireNanoid21,
  requireNonemptyString,
  requireUnicodeString,
  type Tokens,
} from "../contracts/common";
import { parseStrictBytes, type JcsObject, type JcsValue } from "../contracts/jcs";
import { isContractError } from "./errors";
import { utf8ByteLength } from "./rows";

export const TAXONOMY_ERROR_VERSION = "arra-taxonomy-error/v1" as const;

export const TAXONOMY_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "invalid_reference",
  "conflict",
  "integrity_failure",
  "writer_unavailable",
  "unsupported_dataset",
  "recovery_required",
  "limit_exceeded",
] as const;

export type TaxonomyErrorCode = (typeof TAXONOMY_ERROR_CODES)[number];

/** One fixed, safe message per code. Never interpolated, never caller text. */
const MESSAGES: Readonly<Record<TaxonomyErrorCode, string>> = Object.freeze({
  invalid_request: "invalid taxonomy request",
  not_found: "taxonomy row not found",
  invalid_reference: "invalid scoped reference",
  conflict: "taxonomy state conflict",
  integrity_failure: "stored state failed integrity validation",
  writer_unavailable: "dataset writer unavailable",
  unsupported_dataset: "unsupported target dataset",
  recovery_required: "writer recovery required",
  limit_exceeded: "taxonomy limit exceeded",
});

export type TaxonomyErrorShape = {
  version: typeof TAXONOMY_ERROR_VERSION;
  code: TaxonomyErrorCode;
  path: string;
  message: string;
};

/**
 * A SEPARATE envelope from `arra-publication-error/v1`.
 *
 * Deliberately separate: unlike publication, taxonomy conflicts are THROWN
 * safe errors rather than returned outcome objects, so sharing one class
 * would blur two different caller contracts.
 */
export class TaxonomyError extends Error {
  readonly code!: TaxonomyErrorCode;
  readonly path!: string;

  constructor(code: TaxonomyErrorCode, path = "") {
    super(MESSAGES[code]);
    this.name = "TaxonomyError";
    // Genuinely non-writable: `readonly` is erased at runtime, and a caller
    // must not be able to relabel an integrity failure as a not_found.
    Object.defineProperty(this, "code", { value: code, writable: false, enumerable: true, configurable: false });
    Object.defineProperty(this, "path", { value: path, writable: false, enumerable: true, configurable: false });
  }

  toJSON(): TaxonomyErrorShape {
    return { version: TAXONOMY_ERROR_VERSION, code: this.code, path: this.path, message: this.message };
  }
}

export function failTaxonomy(code: TaxonomyErrorCode, path = ""): never {
  throw new TaxonomyError(code, path);
}

const MAX_REQUEST_BYTES = 1048576;
const MAX_REQUEST_DEPTH = 64;
const MAX_NAME_BYTES = 256;
const MAX_WORKSPACE_BYTES = 256;
const NANOID21 = /^[A-Za-z0-9_-]{21}$/;

export const RESERVED_VOCABULARY_NAMES = ["type", "memory_horizon"] as const;
export const VOCABULARY_KINDS = ["tags", "categories"] as const;
export const TERM_POLICIES = ["open", "sealed"] as const;
export const CARDINALITIES = ["one", "many"] as const;
export const HIERARCHIES = ["flat", "tree"] as const;

/** Physical order, quoted from target_v1/taxonomy.py:14. Not invented here. */
export const VOCABULARY_FIELDS = [
  "id", "name", "workspace_name", "label", "description", "kind",
  "term_policy", "cardinality", "required", "hierarchy",
  "h_metadata", "internal_metadata", "created_at",
] as const;

/** Physical order, quoted from target_v1/taxonomy.py:30. No label field exists. */
export const TERM_FIELDS = [
  "id", "workspace_name", "vocabulary_id", "name", "description",
  "parent_id", "weight", "is_active", "h_metadata", "created_at",
] as const;

export type VocabularyField = (typeof VOCABULARY_FIELDS)[number];
export type TermField = (typeof TERM_FIELDS)[number];

/** Literal staging order. Load-bearing: a crash prefix is only nameable if fixed. */
export const SEED_TERM_ORDER = [
  "note", "conclusion", "learning", "discussion", "correction",
  "short_term", "long_term",
] as const;
export const SEED_VOCABULARY_ORDER = ["type", "memory_horizon"] as const;

const TYPE_TERMS = ["note", "conclusion", "learning", "discussion", "correction"] as const;
const HORIZON_TERMS = ["short_term", "long_term"] as const;

/**
 * Strict SHAPE failures keep the governed `arra-error/v1` envelope.
 *
 * Missing keys, unknown keys, wrong types, bad enums and non-Booleans are
 * grammar, not taxonomy semantics, so they go through the shared
 * `contracts/common` helpers rather than a second copy of the same rules
 * pinned to this module. That also inherits the helpers' RFC 6901 escaping
 * and their deterministic unknown-key ordering, neither of which a local
 * string-concatenated path would reproduce.
 *
 * Only taxonomy SEMANTICS -- reserved names, duplicate manifest identities,
 * stored-state corruption -- use the taxonomy envelope.
 */
function parseRequest(bytes: Uint8Array): JcsValue {
  if (!(bytes instanceof Uint8Array)) {
    // A non-bytes entrypoint would be a second, ungoverned parser path.
    failTaxonomy("invalid_request", "");
  }
  try {
    return parseStrictBytes(bytes, [], {
      maxBytes: MAX_REQUEST_BYTES,
      maxDepth: MAX_REQUEST_DEPTH,
    });
  } catch (error) {
    if (isContractError(error)) throw error;
    return failTaxonomy("invalid_request", "");
  }
}

/** Nonempty valid Unicode, 256 UTF-8 bytes. No trim, no case fold, no NFC. */
function requireName(value: JcsValue | undefined, tokens: Tokens): string {
  return requireBoundedText(requireNonemptyString(value ?? null, tokens), MAX_NAME_BYTES, tokens);
}

/** The existing nonblank workspace grammar: nonempty AFTER trimming, 256 bytes. */
function requireWorkspace(value: JcsValue | undefined, tokens: Tokens = ["workspace_name"]): string {
  const text = requireName(value, tokens);
  if (text.trim().length === 0) failTaxonomy("invalid_request", "/workspace_name");
  return text;
}

function requireId(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNanoid21(value ?? null, tokens);
}

function requireNullableId(value: JcsValue | undefined, tokens: Tokens): string | null {
  return value === null ? null : requireId(value, tokens);
}

/**
 * A description is ANY valid Unicode string, or null.
 *
 * Deliberately NOT bounded at 256 and deliberately allowed to be empty: the
 * request byte cap is its only bound. An earlier version of this file applied
 * the name rules here, which would have rejected both an empty description and
 * a long one that the contract accepts.
 */
function requireNullableDescription(value: JcsValue | undefined, tokens: Tokens): string | null {
  return value === null ? null : requireUnicodeString(value ?? null, tokens);
}

/** A display label is nonempty, and also carries NO 256-byte cap. */
function requireLabel(value: JcsValue | undefined, tokens: Tokens): string {
  return requireNonemptyString(value ?? null, tokens);
}

export type GetVocabularyRequest = { workspace_name: string; vocabulary_id: string };
export type GetTermRequest = { workspace_name: string; term_id: string };
export type RetireTermRequest = GetTermRequest;

export type CreateVocabularyRequest = {
  workspace_name: string;
  vocabulary_id: string;
  name: string;
  label: string;
  description: string | null;
  kind: (typeof VOCABULARY_KINDS)[number];
  term_policy: (typeof TERM_POLICIES)[number];
  cardinality: (typeof CARDINALITIES)[number];
  required: boolean;
  hierarchy: (typeof HIERARCHIES)[number];
};

export type CreateTermRequest = {
  workspace_name: string;
  term_id: string;
  vocabulary_id: string;
  name: string;
  description: string | null;
  parent_id: string | null;
};

export type RenameTermRequest = {
  workspace_name: string;
  term_id: string;
  expected_name: string;
  name: string;
};

export type ReparentTermRequest = {
  workspace_name: string;
  term_id: string;
  expected_parent_id: string | null;
  parent_id: string | null;
};

export function parseGetVocabulary(bytes: Uint8Array): GetVocabularyRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "vocabulary_id"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    vocabulary_id: requireId(request.get("vocabulary_id"), ["vocabulary_id"]),
  };
}

export function parseGetTerm(bytes: Uint8Array): GetTermRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "term_id"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    term_id: requireId(request.get("term_id"), ["term_id"]),
  };
}

export function parseRetireTerm(bytes: Uint8Array): RetireTermRequest {
  return parseGetTerm(bytes);
}

export function parseCreateVocabulary(bytes: Uint8Array): CreateVocabularyRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "vocabulary_id", "name", "label", "description",
     "kind", "term_policy", "cardinality", "required", "hierarchy"], []);
  const name = requireName(request.get("name"), ["name"]);
  // Reserved names belong to bootstrap alone. This is a policy refusal, so it
  // is invalid_request at /name rather than a conflict.
  if ((RESERVED_VOCABULARY_NAMES as readonly string[]).includes(name)) {
    failTaxonomy("invalid_request", "/name");
  }
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    vocabulary_id: requireId(request.get("vocabulary_id"), ["vocabulary_id"]),
    name,
    label: requireLabel(request.get("label"), ["label"]),
    description: requireNullableDescription(request.get("description"), ["description"]),
    kind: requireEnum(request.get("kind") ?? null, VOCABULARY_KINDS, ["kind"]),
    term_policy: requireEnum(request.get("term_policy") ?? null, TERM_POLICIES, ["term_policy"]),
    cardinality: requireEnum(request.get("cardinality") ?? null, CARDINALITIES, ["cardinality"]),
    required: requireBoolean(request.get("required") ?? null, ["required"]),
    hierarchy: requireEnum(request.get("hierarchy") ?? null, HIERARCHIES, ["hierarchy"]),
  };
}

export function parseCreateTerm(bytes: Uint8Array): CreateTermRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "term_id", "vocabulary_id", "name", "description", "parent_id"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    term_id: requireId(request.get("term_id"), ["term_id"]),
    vocabulary_id: requireId(request.get("vocabulary_id"), ["vocabulary_id"]),
    name: requireName(request.get("name"), ["name"]),
    description: requireNullableDescription(request.get("description"), ["description"]),
    parent_id: requireNullableId(request.get("parent_id"), ["parent_id"]),
  };
}

export function parseRenameTerm(bytes: Uint8Array): RenameTermRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "term_id", "expected_name", "name"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    term_id: requireId(request.get("term_id"), ["term_id"]),
    expected_name: requireName(request.get("expected_name"), ["expected_name"]),
    name: requireName(request.get("name"), ["name"]),
  };
}

export function parseReparentTerm(bytes: Uint8Array): ReparentTermRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "term_id", "expected_parent_id", "parent_id"], []);
  return {
    workspace_name: requireWorkspace(request.get("workspace_name")),
    term_id: requireId(request.get("term_id"), ["term_id"]),
    expected_parent_id: requireNullableId(request.get("expected_parent_id"), ["expected_parent_id"]),
    parent_id: requireNullableId(request.get("parent_id"), ["parent_id"]),
  };
}

export type SeedRequest = {
  workspace_name: string;
  type: { vocabulary_id: string; terms: Record<(typeof TYPE_TERMS)[number], string> };
  memory_horizon: { vocabulary_id: string; terms: Record<(typeof HORIZON_TERMS)[number], string> };
};

export function parseSeedRequest(bytes: Uint8Array): SeedRequest {
  const request = requireClosedObject(parseRequest(bytes), ["workspace_name", "type", "memory_horizon"], []);
  const workspace = requireWorkspace(request.get("workspace_name"));

  const branch = <K extends readonly string[]>(raw: JcsValue | undefined, group: string, terms: K) => {
    // Tokens, not concatenated strings: the shared helper owns RFC 6901
    // escaping and the deterministic unknown-key ordering.
    const node = requireClosedObject(raw ?? null, ["vocabulary_id", "terms"], [group]);
    const termObject = requireClosedObject(node.get("terms") ?? null, terms, [group, "terms"]);
    const ids: Record<string, string> = {};
    for (const key of terms) {
      ids[key] = requireId(termObject.get(key), [group, "terms", key]);
    }
    return {
      vocabulary_id: requireId(node.get("vocabulary_id"), [group, "vocabulary_id"]),
      terms: ids,
    };
  };

  const type = branch(request.get("type"), "type", TYPE_TERMS);
  const horizon = branch(request.get("memory_horizon"), "memory_horizon", HORIZON_TERMS);

  // All nine IDs distinct within the supplied workspace. Reported against the
  // LATER occurrence, which is the one that collides with what came before.
  const seen = new Set<string>();
  const check = (value: string, path: string) => {
    if (seen.has(value)) failTaxonomy("invalid_request", path);
    seen.add(value);
  };
  check(type.vocabulary_id, "/type/vocabulary_id");
  for (const key of TYPE_TERMS) check(type.terms[key]!, `/type/terms/${key}`);
  check(horizon.vocabulary_id, "/memory_horizon/vocabulary_id");
  for (const key of HORIZON_TERMS) check(horizon.terms[key]!, `/memory_horizon/terms/${key}`);

  return {
    workspace_name: workspace,
    type: type as SeedRequest["type"],
    memory_horizon: horizon as SeedRequest["memory_horizon"],
  };
}

const MICROS_PER_MILLI = 1000n;

/** Raw Arrow cell -> microseconds. No Date fallback: a Date has already lost
 *  whatever sub-millisecond precision the timestamp[us] column held. */
function rawMicros(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failTaxonomy("integrity_failure");
    return BigInt(value);
  }
  return failTaxonomy("integrity_failure");
}

/** Exact UTC millisecond string, or integrity_failure. Remainder is rejected
 *  BEFORE any Number conversion, so a stored time is never rounded into a
 *  value the store does not hold. */
function storedTimestamp(value: unknown): string {
  const micros = rawMicros(value);
  if (micros % MICROS_PER_MILLI !== 0n) failTaxonomy("integrity_failure");
  const millis = micros / MICROS_PER_MILLI;
  if (millis < -8640000000000000n || millis > 8640000000000000n) failTaxonomy("integrity_failure");
  const text = new Date(Number(millis)).toISOString();
  if (Date.parse(text) !== Number(millis)) failTaxonomy("integrity_failure");
  return text;
}

/** Stored-state validators. Same bad value from the STORE is corruption, so
 *  these are integrity_failure, never the request codes above. */
function storedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) failTaxonomy("integrity_failure");
  return value;
}

function storedNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") failTaxonomy("integrity_failure");
  return value;
}

function storedEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) failTaxonomy("integrity_failure");
  return value as T;
}

function storedBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") failTaxonomy("integrity_failure");
  return value;
}

function storedWeight(value: unknown): number {
  // Finite number only. This slice creates zero, but an existing non-zero
  // stored value is preserved exactly rather than clamped.
  if (typeof value !== "number" || !Number.isFinite(value)) failTaxonomy("integrity_failure");
  return value;
}

export function encodeVocabularyRow(row: Record<string, unknown>): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    id: storedText(row.id),
    name: storedText(row.name),
    workspace_name: storedText(row.workspace_name),
    label: storedText(row.label),
    description: storedNullableText(row.description),
    kind: storedEnum(row.kind, VOCABULARY_KINDS),
    term_policy: storedEnum(row.term_policy, TERM_POLICIES),
    cardinality: storedEnum(row.cardinality, CARDINALITIES),
    required: storedBoolean(row.required),
    hierarchy: storedEnum(row.hierarchy, HIERARCHIES),
    h_metadata: storedNullableText(row.h_metadata),
    internal_metadata: storedNullableText(row.internal_metadata),
    created_at: storedTimestamp(row.created_at),
  };
  return encoded;
}

export function encodeTermRow(row: Record<string, unknown>): Record<string, unknown> {
  const encoded: Record<string, unknown> = {
    id: storedText(row.id),
    workspace_name: storedText(row.workspace_name),
    vocabulary_id: storedText(row.vocabulary_id),
    name: storedText(row.name),
    description: storedNullableText(row.description),
    parent_id: row.parent_id === null || row.parent_id === undefined ? null : storedText(row.parent_id),
    weight: storedWeight(row.weight),
    is_active: storedBoolean(row.is_active),
    h_metadata: storedNullableText(row.h_metadata),
    created_at: storedTimestamp(row.created_at),
  };
  return encoded;
}

/**
 * The literal bootstrap rows.
 *
 * `createdAtMs` comes from the trusted clock and is used ONLY for rows that
 * are actually missing; an existing row keeps its own validated allocation
 * time rather than being resampled.
 */
export function seedVocabularyRows(
  request: SeedRequest,
  createdAtMs: number,
): Array<Record<string, unknown>> {
  const micros = BigInt(createdAtMs) * MICROS_PER_MILLI;
  const common = {
    workspace_name: request.workspace_name,
    description: null,
    kind: "categories",
    term_policy: "sealed",
    cardinality: "one",
    hierarchy: "flat",
    h_metadata: null,
    internal_metadata: null,
    created_at: micros,
  };
  return [
    // type is required: an omitted type resolves to note.
    { id: request.type.vocabulary_id, name: "type", label: "Type", required: true, ...common },
    // memory_horizon is not: an omitted horizon stays unclassified.
    {
      id: request.memory_horizon.vocabulary_id,
      name: "memory_horizon",
      label: "Memory horizon",
      required: false,
      ...common,
    },
  ].map((row) => {
    const ordered: Record<string, unknown> = {};
    for (const field of VOCABULARY_FIELDS) ordered[field] = row[field as keyof typeof row];
    return ordered;
  });
}

export function seedTermRows(
  request: SeedRequest,
  createdAtMs: number,
): Array<Record<string, unknown>> {
  const micros = BigInt(createdAtMs) * MICROS_PER_MILLI;
  const rows: Array<Record<string, unknown>> = [];
  const push = (id: string, name: string, vocabularyId: string) => {
    const row: Record<string, unknown> = {
      id,
      workspace_name: request.workspace_name,
      vocabulary_id: vocabularyId,
      name,
      description: null,
      parent_id: null,
      weight: 0,
      is_active: true,
      h_metadata: null,
      created_at: micros,
    };
    const ordered: Record<string, unknown> = {};
    for (const field of TERM_FIELDS) ordered[field] = row[field];
    rows.push(ordered);
  };
  // Literal staging order: type terms first, then horizon terms.
  for (const key of TYPE_TERMS) push(request.type.terms[key]!, key, request.type.vocabulary_id);
  for (const key of HORIZON_TERMS) {
    push(request.memory_horizon.terms[key]!, key, request.memory_horizon.vocabulary_id);
  }
  return rows;
}
