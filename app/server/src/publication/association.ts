/**
 * Association request grammar, cursor validation and physical row derivation.
 *
 * PURE by contract. No SDK import, and nothing here acquires, retains or
 * returns a connection, table, adapter or owner. Materialization and evidence
 * persistence stay private in service.ts, so this module can be exercised
 * without a dataset and cannot become a back door to one.
 *
 * TWO envelopes, neither new:
 *   - governed ContractError / arra-error/v1 for parse, shape, value and the
 *     cursor scope_mismatch. Those come from the shared codec helpers, so RFC
 *     6901 escaping and deterministic unknown-key ordering are inherited.
 *   - PublicationError / arra-publication-error/v1 for STORED-state failures,
 *     always at the ROOT path.
 *
 * Contract: app/docs/contracts/association-evidence-v1.md
 */

import {
  requireBoundedText,
  requireClosedObject,
  requireNanoid21,
  requireNonemptyString,
  requireNonNegativeInt64String,
  requirePositiveInt64String,
  type Tokens,
} from "../contracts/common";
import { ContractError, fail } from "../contracts/errors";
import { targetOp, type TargetResult } from "../contracts/evidence-v1";
import { parseStrict, parseStrictBytes, type JcsObject, type JcsValue } from "../contracts/jcs";
import { failPublication } from "./errors";

const MAX_REQUEST_BYTES = 1048576;
const MAX_REQUEST_DEPTH = 64;
const MAX_NAME_BYTES = 256;
const INT64_MAX = 2n ** 63n - 1n;

/** Exactly the two modes. `current` means HEAD -- not a lifecycle filter. */
export const REVISION_MODES = ["current", "history"] as const;
export type RevisionMode = (typeof REVISION_MODES)[number];

export const MAX_PAGE_LIMIT = 100;
/** Traversal budgets, per call. Application limits, NOT a bound on SDK work. */
export const MAX_VISITED_NODES = 32;
export const MAX_SELECTED_REVISIONS = 128;
export const MAX_EXAMINED_POSITIONS = 4096;
export const MAX_RESULT_WIRE_BYTES = 16 * 1024 * 1024;

/** Physical order, quoted from the contract. No invented link id. */
export const TERM_FIELDS = [
  "workspace_name", "revision_id", "term_id", "vocabulary_id",
  "vocabulary_name_snapshot", "term_name_snapshot", "label_snapshot", "position",
] as const;
export const LINK_FIELDS = [
  "workspace_name", "revision_id", "position", "relation", "target_kind",
  "target", "target_key", "excerpt", "content_hash", "captured_at",
  "capture_status", "note",
] as const;

export const CURSOR_KEYS = [
  "workspace_name", "target_kind", "target_key", "revision_mode",
  "nodes_version", "node_id", "revision_no", "position",
] as const;

/** The FIXED message. Never paraphrased: the message is part of the envelope. */
const CURSOR_MISMATCH = "evidence cursor does not match request";

function parseRequest(bytes: Uint8Array, tokens: Tokens = []): JcsObject {
  if (!(bytes instanceof Uint8Array)) fail("invalid_type", tokens, "expected request bytes");
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

/**
 * Canonical Int64 decimal TEXT, through the ACCEPTED helpers.
 *
 * An earlier version of this file re-implemented the grammar locally and
 * emitted `invalid_value` where the governed helpers emit `out_of_range` with
 * their own messages. That is a second parser with a divergent envelope, which
 * is exactly what the contract forbids -- and no path-only assertion could see
 * the difference.
 */
function int64Text(
  value: JcsValue | undefined,
  tokens: Tokens,
  bound: "positive" | "nonnegative",
): string {
  const v = value ?? null;
  return bound === "positive"
    ? requirePositiveInt64String(v, tokens).text
    : requireNonNegativeInt64String(v, tokens).text;
}

export type GetRevisionAssociationsRequest = {
  workspace_name: string;
  node_id: string;
  revision_id: string | null;
};
export type ReconcileRequest = {
  workspace_name: string;
  node_id: string;
  revision_id: string;
};
export type ScanCursor = {
  workspace_name: string;
  target_kind: string;
  target_key: string;
  revision_mode: RevisionMode;
  nodes_version: string;
  node_id: string;
  revision_no: string | null;
  position: string | null;
};
export type ScanDependentsRequest = {
  workspace_name: string;
  target_kind: string;
  target: JcsValue;
  target_key: string;
  target_json: string;
  revision_mode: RevisionMode;
  limit: number;
  cursor: ScanCursor | null;
};

export function parseGetRevisionAssociations(bytes: Uint8Array): GetRevisionAssociationsRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "node_id", "revision_id"], []);
  const rawRevision = o.get("revision_id");
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    node_id: requireNanoid21(o.get("node_id") ?? null, ["node_id"]),
    // null means the CAPTURED HEAD, and is distinct from omitting the key.
    revision_id: rawRevision === null ? null : requireNanoid21(rawRevision ?? null, ["revision_id"]),
  };
}

export function parseReconcileRevisionAssociations(bytes: Uint8Array): ReconcileRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "node_id", "revision_id"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    node_id: requireNanoid21(o.get("node_id") ?? null, ["node_id"]),
    // REQUIRED nonnull: a materializer must name the revision it materializes.
    revision_id: requireNanoid21(o.get("revision_id") ?? null, ["revision_id"]),
  };
}

function requireMode(value: JcsValue | undefined, tokens: Tokens): RevisionMode {
  if (typeof value !== "string") fail("invalid_type", tokens, "expected string");
  if (!(REVISION_MODES as readonly string[]).includes(value)) {
    fail("invalid_value", tokens, `expected one of ${REVISION_MODES.join(", ")}`);
  }
  return value as RevisionMode;
}

/**
 * Validate the cursor against THIS request.
 *
 * Comparison order is fixed by the contract: workspace_name, target_kind,
 * target_key, revision_mode -- each at its own `/cursor/...` pointer, with the
 * FIXED message. `target_key` is checked against the key this request derives,
 * so a cursor can never act as an alternate raw-key lookup.
 */
function parseCursor(
  raw: JcsValue,
  request: { workspace_name: string; target_kind: string; target_key: string; revision_mode: RevisionMode },
): ScanCursor {
  const o = requireClosedObject(raw, CURSOR_KEYS, ["cursor"]);
  const mismatch = (field: string): never =>
    fail("scope_mismatch", ["cursor", field], CURSOR_MISMATCH);

  const workspace = name(o.get("workspace_name"), ["cursor", "workspace_name"]);
  if (workspace !== request.workspace_name) mismatch("workspace_name");
  const kind = requireNonemptyString(o.get("target_kind") ?? null, ["cursor", "target_kind"]);
  if (kind !== request.target_kind) mismatch("target_kind");
  const key = requireNonemptyString(o.get("target_key") ?? null, ["cursor", "target_key"]);
  if (key !== request.target_key) mismatch("target_key");
  const mode = requireMode(o.get("revision_mode"), ["cursor", "revision_mode"]);
  if (mode !== request.revision_mode) mismatch("revision_mode");

  // A table version is positive; an ordinal is positive; a position is
  // nonnegative. Each at its own pointer.
  const nodesVersion = int64Text(o.get("nodes_version"), ["cursor", "nodes_version"], "positive");
  const nodeId = requireNanoid21(o.get("node_id") ?? null, ["cursor", "node_id"]);
  const rawRevisionNo = o.get("revision_no");
  const rawPosition = o.get("position");
  const revisionNo =
    rawRevisionNo === null ? null : int64Text(rawRevisionNo, ["cursor", "revision_no"], "positive");
  // Forbidden combination, checked BEFORE the position's own grammar so the
  // structural error is reported rather than a value error on a field that
  // should not be present at all.
  if (revisionNo === null && rawPosition !== null) {
    fail("invalid_value", ["cursor", "position"], "position requires a revision_no");
  }
  const position =
    rawPosition === null ? null : int64Text(rawPosition, ["cursor", "position"], "nonnegative");

  return {
    workspace_name: workspace, target_kind: kind, target_key: key, revision_mode: mode,
    nodes_version: nodesVersion, node_id: nodeId, revision_no: revisionNo, position,
  };
}

export function parseScanDependents(bytes: Uint8Array): ScanDependentsRequest {
  const o = requireClosedObject(
    parseRequest(bytes),
    ["workspace_name", "target_kind", "target", "revision_mode", "limit", "cursor"],
    [],
  );
  const workspace = name(o.get("workspace_name"), ["workspace_name"]);
  const rawKind = o.get("target_kind") ?? null;
  const rawTarget = o.get("target") ?? null;
  // The ACCEPTED codec validates kind and target together and derives the key.
  // There is no raw caller-supplied target key anywhere in this grammar.
  const derived: TargetResult = targetOp(workspace, rawKind, rawTarget, []);
  const mode = requireMode(o.get("revision_mode"), ["revision_mode"]);

  const rawLimit = o.get("limit");
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
    fail("invalid_type", ["limit"], "expected integer");
  }
  if (rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    fail("invalid_value", ["limit"], `expected 1..${MAX_PAGE_LIMIT}`);
  }

  const rawCursor = o.get("cursor");
  const cursor =
    rawCursor === null
      ? null
      : parseCursor(rawCursor ?? null, {
          workspace_name: workspace,
          target_kind: rawKind as string,
          target_key: derived.target_key,
          revision_mode: mode,
        });

  return {
    workspace_name: workspace,
    target_kind: rawKind as string,
    target: rawTarget,
    target_key: derived.target_key,
    target_json: derived.target_json,
    revision_mode: mode,
    limit: rawLimit,
    cursor,
  };
}

/* ------------------------------------------------------------------ *
 * Row derivation. STORED-state failures only, integrity at ROOT.
 * ------------------------------------------------------------------ */

function snapshotText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) failPublication("integrity_failure");
  return value;
}

function snapshotNullableText(value: unknown): string | null {
  // EXPLICIT null only. Treating `undefined` as null would fabricate a missing
  // nullable field into a legitimate one, so an absent key is stored-state
  // corruption rather than a silent null.
  if (value === null) return null;
  // EMPTY is a retained display value, not an absent one.
  if (typeof value !== "string") failPublication("integrity_failure");
  return value;
}

/** Canonical nonnegative Int64 decimal text, from a snapshot entry. */
function snapshotPosition(value: unknown): string {
  if (typeof value !== "string") failPublication("integrity_failure");
  if (value === "-0" || !/^(0|[1-9][0-9]*)$/.test(value)) failPublication("integrity_failure");
  if (BigInt(value) > INT64_MAX) failPublication("integrity_failure");
  return value;
}

function ordered(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = row[field];
  return out;
}

/** Derive the complete expected TERM rows from a normalized snapshot. */
export function deriveTermRows(
  workspace: string,
  revisionId: string,
  entries: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown>[] {
  return entries.map((entry) =>
    ordered(
      {
        workspace_name: workspace,
        revision_id: revisionId,
        term_id: snapshotText(entry.term_id),
        vocabulary_id: snapshotText(entry.vocabulary_id),
        vocabulary_name_snapshot: snapshotText(entry.vocabulary_name_snapshot),
        term_name_snapshot: snapshotText(entry.term_name_snapshot),
        // Historical rows are NOT revalidated against today's term names,
        // activity or policy; the snapshot is what it is.
        label_snapshot: snapshotNullableText(entry.label_snapshot),
        position: snapshotPosition(entry.position),
      },
      TERM_FIELDS,
    ),
  );
}

/** Derive the complete expected LINK rows from a normalized snapshot. */
export function deriveLinkRows(
  workspace: string,
  revisionId: string,
  entries: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown>[] {
  return entries.map((entry) => {
    let derived: TargetResult;
    try {
      // A snapshot entry is a PLAIN object: parseSnapshotArray uses JSON.parse,
      // and the accepted link validator reads entries as plain objects. The
      // codec wants a JcsValue, so the target is re-read through the GOVERNED
      // parser rather than converted by hand -- a local object-to-Map walker
      // would be a second parser with its own escaping and depth rules.
      const targetValue = parseStrict(JSON.stringify(entry.target ?? null), []);
      // target text and target_key from the SAME codec result, so the two can
      // never disagree.
      derived = targetOp(workspace, entry.target_kind as JcsValue, targetValue, []);
    } catch (error) {
      // ONLY a governed codec rejection means the stored snapshot is corrupt.
      // A catch-all here would relabel a programming fault -- a TypeError, a
      // bad call -- as stored corruption and hide it behind a plausible
      // integrity_failure.
      if (!(error instanceof ContractError)) throw error;
      return failPublication("integrity_failure");
    }
    return ordered(
      {
        workspace_name: workspace,
        revision_id: revisionId,
        position: snapshotPosition(entry.position),
        relation: snapshotText(entry.relation),
        target_kind: snapshotText(entry.target_kind),
        target: derived.target_json,
        target_key: derived.target_key,
        // Ordinary capture annotations are not identity and are not proof of
        // retrieval; they are retained exactly, including empty strings.
        excerpt: snapshotNullableText(entry.excerpt),
        content_hash: snapshotNullableText(entry.content_hash),
        captured_at: snapshotNullableText(entry.captured_at),
        capture_status: snapshotText(entry.capture_status),
        note: snapshotNullableText(entry.note),
      },
      LINK_FIELDS,
    );
  });
}
