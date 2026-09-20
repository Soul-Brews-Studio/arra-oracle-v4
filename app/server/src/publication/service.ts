/**
 * The local publication kernel (`revision-publication-v1.md`).
 *
 * Three internal methods, all taking raw bytes: publish a revision, read the
 * accepted head, list accepted ancestry. This is not a route and not a
 * service surface -- a future caller enters through #25 admission first.
 *
 * Design points worth stating, because each one is a decision rather than an
 * accident:
 *
 * * Acceptance is ANCESTRY, not row presence. A row existing in the table
 *   proves nothing; it counts only if it is reachable backwards from the head
 *   captured for THIS read, within the same workspace and node.
 * * Retries reuse the stored revision ID, ordinal and timestamp. An
 *   idempotent replay returns the ORIGINAL values even when a later head
 *   exists -- it must not pretend the old revision is current.
 * * Publication is fail-stop. Any ambiguous persistence outcome, unexpected
 *   affected-row count or failed readback poisons the owner; no further
 *   queued mutation runs and a fresh owner must inspect durable state.
 * * Nothing here deletes, patches or rolls back. Recovery reconstructs from
 *   immutable rows, so a crash leaves evidence rather than a repaired lie.
 */

import { parseStrictBytes, type JcsObject, type JcsValue } from "../contracts/jcs";
import { ENVELOPE_KEYS, revisionOp, verifyRevisionOp, type RevisionResult } from "../contracts/revision-v1";
import { ContractError, fail as failGoverned } from "../contracts/errors";
import { failPublication, isContractError, PublicationError } from "./errors";
import {
  classifyMessageDestinationReplay,
  prepareNewMessage,
} from "../contracts/source-ingestion-v1";
import {
  encodeMessageRow,
  encodePeerRow,
  encodeSessionPeerRow,
  encodeSessionRow,
  parseAppendMessages,
  parseGetMessage,
  parseGetPeer,
  parseGetSession,
  parseJoinSession,
  parseListMessages,
  parseRegisterPeer,
  parseRegisterSession,
  rowWireBytes,
  MAX_RESULT_WIRE_BYTES,
  MESSAGE_FIELDS as MESSAGE_FIELDS_LOCAL,
  PEER_FIELDS as PEER_FIELDS_LOCAL,
  SESSION_FIELDS as SESSION_FIELDS_LOCAL,
  SESSION_PEER_FIELDS as SESSION_PEER_FIELDS_LOCAL,
} from "./context";
import {
  encodeTermRow,
  encodeVocabularyRow,
  failTaxonomy,
  parseCreateTerm,
  parseCreateVocabulary,
  parseGetTerm,
  parseGetVocabulary,
  parseRenameTerm,
  parseReparentTerm,
  parseRetireTerm,
  parseSeedRequest,
  seedTermRows,
  seedVocabularyRows,
  SEED_TERM_ORDER,
  TaxonomyError,
  TERM_FIELDS,
  VOCABULARY_FIELDS,
  type TaxonomyErrorCode,
} from "./taxonomy";
import {
  EMPTY_ARRAY_BYTES,
  MAX_CHAIN_ROWS,
  MAX_CHAIN_WIRE_BYTES,
  encodeNodeRow,
  encodeRevisionRow,
  parseInt64Text,
  revisionWireBytes,
  timestampToMicros,
  utf8ByteLength,
} from "./rows";
import { closeSync } from "node:fs";
import { connect } from "@lancedb/lancedb";
import { tableFromArrays } from "apache-arrow";
import {
  assertInheritedGate,
  assertLocalDatasetRoot,
  assertTargetDataset,
  decodeArrowRows,
  quote,
  rawRows,
  TARGET_TABLES,
  type Connection,
  type Table,
} from "./storage";

/**
 * The private dataset adapter.
 *
 * Deliberately NOT exported, and not constructible from `storage.ts` either:
 * that module exports validation helpers and raw-row decoding ONLY -- no
 * connection factory, no adapter, no table. Connection opening lives here,
 * private. So there is no importable factory anywhere that lets a caller
 * mutate the dataset without going through the scoped service built below.
 * Moving mutators behind an exported `openWriteAdapter` would only have
 * relocated the authority, not removed it.
 */
type DatasetAdapter = {
  query(table: string, predicate: string, limit?: number): Promise<Record<string, unknown>[]>;
  /**
   * Ordered projection of a few key columns.
   *
   * PRIVATE, and separate from `query` on purpose. `query` has no ordering, so
   * a bare limit there returns ARBITRARY rows and can never yield an extremum
   * -- measured on the pinned stack. This is the only shape allowed to pick a
   * maximum or page a keyset.
   *
   * Ordered output bounds JS materialization. It does NOT bound SDK engine
   * scan work or execution time, and nothing here should be read as claiming
   * otherwise.
   */
  orderedProjection(
    table: string,
    predicate: string,
    columns: string[],
    ordering: { column: string; ascending: boolean },
    limit: number,
  ): Promise<Record<string, unknown>[]>;
  refresh(table: string): Promise<void>;
  version(table: string): Promise<number>;
  append(table: string, rows: Record<string, unknown>[]): Promise<number>;
  updateWhere(
    table: string,
    predicate: string,
    assignments: Record<string, string>,
  ): Promise<{ rowsUpdated: number; version: number }>;
  release(): void;
};

/**
 * One owner per canonical dataset root, per process.
 *
 * The external gate excludes other PROCESSES; this excludes a second owner
 * inside this one. Keyed by canonical root so two spellings cannot both win.
 */
const OWNERS = new Map<string, symbol>();

function makeAdapter(connection: Connection, onRelease: () => void): DatasetAdapter {
  const handles = new Map<string, Table>();
  let released = false;

  const handle = async (table: string): Promise<Table> => {
    // A released adapter stops working: closing is a gate, not a hint.
    if (released) failPublication("recovery_required");
    if (!TARGET_TABLES.includes(table)) failPublication("integrity_failure");
    let existing = handles.get(table);
    if (existing === undefined) {
      existing = await connection.openTable(table);
      handles.set(table, existing);
    }
    return existing;
  };

  return {
    async query(table, predicate, limit) {
      const tbl = await handle(table);
      await tbl.checkoutLatest();
      return rawRows(tbl, predicate, limit);
    },
    async orderedProjection(table, predicate, columns, ordering, limit) {
      const tbl = await handle(table);
      await tbl.checkoutLatest();
      const arrow = await tbl
        .query()
        .where(predicate)
        .select(columns)
        .orderBy([{ columnName: ordering.column, ascending: ordering.ascending }])
        .limit(limit)
        .toArrow();
      // Same decoder as rawRows, deliberately: a second decoding path is how a
      // lossy Number fallback returns on one side only.
      return decodeArrowRows(arrow);
    },
    async refresh(table) {
      await (await handle(table)).checkoutLatest();
    },
    async version(table) {
      return (await handle(table)).version();
    },
    async append(table, rows) {
      const tbl = await handle(table);
      // Build an Arrow table rather than handing over plain objects.
      //
      // MEASURED on the installed stack: a plain object with a BigInt
      // timestamp is rejected outright, and a JS NUMBER is far worse -- it is
      // accepted and silently corrupts, with 253402300799999000 reading back
      // as -4852116231934706. Arrow construction from BigInts round-trips
      // exactly, including sub-millisecond and the far Gregorian boundary.
      const columns: Record<string, unknown[]> = {};
      for (const row of rows) {
        for (const key of Object.keys(row)) (columns[key] ??= []).push(row[key]);
      }
      await tbl.add(tableFromArrays(columns as never) as never);
      return tbl.version();
    },
    async updateWhere(table, predicate, assignments) {
      const tbl = await handle(table);
      await tbl.checkoutLatest();
      const result = (await tbl.update(assignments, { where: predicate })) as unknown as {
        rowsUpdated?: number;
      };
      return {
        rowsUpdated: typeof result?.rowsUpdated === "number" ? result.rowsUpdated : 0,
        version: await tbl.version(),
      };
    },
    release() {
      released = true;
      handles.clear();
      onRelease();
    },
  };
}

/**
 * Open and validate a connection, privately.
 *
 * Lives here rather than in `storage.ts` so no module exports a function
 * returning a raw `Connection`. readConsistencyInterval 0 makes every read
 * re-check for a newer version instead of serving what this process last saw.
 */
async function openPrivateConnection(canonicalRoot: string): Promise<Connection> {
  const connection = await connect(canonicalRoot, { readConsistencyInterval: 0 });
  await assertTargetDataset(connection);
  return connection;
}

/**
 * Release the inherited writer descriptor.
 *
 * The flock is held by fd 42, not by the registry entry, so this is the step
 * that actually frees the dataset for another owner while this process keeps
 * running. Safe to call more than once.
 */
function releaseInheritedGate(): void {
  const declared = process.env.ARRA_WRITER_FD;
  if (declared === undefined) return;
  const fd = Number(declared);
  if (!Number.isSafeInteger(fd) || fd < 0) return;
  try {
    closeSync(fd);
  } catch {
    // Already closed, or never ours. Either way there is nothing to release
    // and failing here would turn a clean shutdown into an error.
  }
}

const MAX_REQUEST_BYTES = 1048576;
const MAX_REQUEST_DEPTH = 64;

/** nanoid21, matching the existing governed grammar. */
const NANOID21 = /^[A-Za-z0-9_-]{21}$/;

export type PublishOutcome =
  | {
      outcome: "accepted" | "idempotent";
      node_id: string;
      revision_id: string;
      revision_no: string;
      content_digest: string;
      node_created_at: string;
      revision_created_at: string;
    }
  | { outcome: "conflict"; reason: "operation_digest" | "node_id" | "stale_base" };

export type Clock = () => number;

/**
 * The four commanded sequence points a fault test may park at.
 *
 * A closed string set, deliberately: the callback receives no handle, no
 * context and no storage access, so it cannot become a side door into the
 * kernel. It demonstrates process death at SDK boundaries, NOT power-loss
 * atomicity.
 */
export type PublicationBoundary =
  | "before_append"
  | "after_revision_append"
  | "after_revision_readback"
  | "after_head_publication";

export type BoundaryHook = (boundary: PublicationBoundary) => Promise<void>;

/**
 * Taxonomy fault seam. Fires PER MUTATED ROW, never per staging phase: a
 * crash-after-the-third-term test can only name WHICH row was written if each
 * row emits its own triple.
 */
export type TaxonomyBoundary =
  | "before_write"
  | "after_term_write"
  | "after_vocabulary_write"
  | "after_update"
  | "after_readback";

export type TaxonomyBoundaryHook = (boundary: TaxonomyBoundary) => Promise<void>;

/** Mint revision IDs. Injected so tests are deterministic without stubbing time. */
export type IdSource = () => string;

// ── request parsing ─────────────────────────────────────────────────────────

function parseRequest(requestBytes: unknown): JcsObject {
  if (!(requestBytes instanceof Uint8Array)) {
    // A non-bytes entrypoint would be a second, ungoverned parser path.
    failPublication("invalid_request", "");
  }
  let parsed: JcsValue;
  try {
    parsed = parseStrictBytes(requestBytes, [], {
      maxBytes: MAX_REQUEST_BYTES,
      maxDepth: MAX_REQUEST_DEPTH,
    });
  } catch (error) {
    // Governed strict-parse failures keep their ORIGINAL arra-error/v1
    // envelope; only publication semantics use the separate codec.
    if (isContractError(error)) throw error;
    return failPublication("invalid_request", "");
  }
  if (!(parsed instanceof Map)) failPublication("invalid_request", "");
  return parsed as JcsObject;
}

function closedKeys(o: JcsObject, keys: readonly string[], base: string): void {
  for (const key of keys) {
    if (!o.has(key)) failPublication("invalid_request", `${base}/${key}`);
  }
  for (const key of o.keys()) {
    if (!keys.includes(key)) failPublication("invalid_request", `${base}/${key}`);
  }
}

function requireWorkspaceName(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) failPublication("invalid_request", path);
  if (utf8ByteLength(value) > 256) failPublication("invalid_request", path);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) failPublication("invalid_request", path);
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      failPublication("invalid_request", path);
    }
  }
  return value;
}

function requireNodeId(value: unknown, path: string): string {
  if (typeof value !== "string" || !NANOID21.test(value)) failPublication("invalid_request", path);
  return value;
}

/**
 * Operation grammar: nonempty valid Unicode.
 *
 * Deliberately NOT restricted to nanoid: the caller owns this key across
 * retries, and narrowing it here would reject legitimate operation IDs the
 * contract allows. No trimming and no case folding either -- the namespace is
 * the exact tuple (workspace_name, "node_revision", operation_id).
 */
function requireOperationId(value: unknown, path: string): string {
  // Nonempty valid Unicode, and deliberately NOTHING more. An invented length
  // cap here would reject operation IDs the contract permits, and the 1 MiB
  // whole-request bound already limits it.
  if (typeof value !== "string" || value.length === 0) failPublication("invalid_request", path);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) failPublication("invalid_request", path);
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      failPublication("invalid_request", path);
    }
  }
  return value;
}

export type ReadRequest = { workspace_name: string; node_id: string };

function parseReadRequest(requestBytes: unknown): ReadRequest {
  const o = parseRequest(requestBytes);
  closedKeys(o, ["workspace_name", "node_id"], "");
  return {
    workspace_name: requireWorkspaceName(o.get("workspace_name"), "/workspace_name"),
    node_id: requireNodeId(o.get("node_id"), "/node_id"),
  };
}

// ── ancestry ────────────────────────────────────────────────────────────────

type RevisionRow = Record<string, unknown>;

/**
 * Encode a stored revision AND prove its canonical bytes still match.
 *
 * Encoding alone accepts whatever is on disk. A row whose body was edited
 * while its `content_digest` stayed put would pass every shape check and be
 * served as accepted history -- which is exactly the hole this closes. The
 * digest is RECOMPUTED from the stored columns and compared, so tampering
 * fails as integrity rather than being trusted because the string looks
 * plausible.
 */
function decodeVerifiedRevision(row: RevisionRow): Record<string, unknown> {
  const encoded = encodeRevisionRow(row);
  const envelope = new Map<string, unknown>();
  for (const key of ENVELOPE_KEYS) envelope.set(key, encoded[key] ?? null);
  try {
    verifyRevisionOp(envelope as never, encoded.content_digest as never, []);
  } catch {
    // Any recompute failure is stored-state corruption, never a request fault.
    failPublication("integrity_failure");
  }
  return encoded;
}

/** Exactly one row, or a distinguishable 0 / >1 outcome. Never `limit(1)`. */
function exactlyOne<T>(rows: T[], path = ""): T | null {
  if (rows.length === 0) return null;
  // >1 means duplicate logical identity: an integrity failure, never a pick.
  if (rows.length > 1) failPublication("integrity_failure", path);
  return rows[0]!;
}

async function findRevisionById(
  reader: DatasetAdapter,
  workspace: string,
  revisionId: string,
): Promise<RevisionRow | null> {
  const rows = await reader.query(
    "node_revisions",
    `workspace_name = ${quote(workspace)} AND id = ${quote(revisionId)}`,
  );
  return exactlyOne(rows);
}

async function findNode(reader: DatasetAdapter, workspace: string, nodeId: string) {
  const rows = await reader.query(
    "nodes",
    `workspace_name = ${quote(workspace)} AND id = ${quote(nodeId)}`,
  );
  return exactlyOne(rows);
}

async function findOperation(
  reader: DatasetAdapter,
  workspace: string,
  operationId: string,
): Promise<RevisionRow | null> {
  const rows = await reader.query(
    "node_revisions",
    `workspace_name = ${quote(workspace)} AND operation_id = ${quote(operationId)}`,
  );
  return exactlyOne(rows);
}

export type Ancestry = {
  /** Oldest first, exactly as `listAcceptedHistory` returns them. */
  rows: RevisionRow[];
  encoded: Record<string, unknown>[];
  wireBytes: number;
};

/**
 * Walk the accepted chain backwards from `headId`, oldest-first on return.
 *
 * Budgets are checked DURING traversal, not after assembling everything: the
 * point of a 16 MiB bound is to avoid building a history that large in the
 * first place. One fetched row may cross the budget; this is a wire bound,
 * not a process-memory sandbox.
 */
async function walkAncestry(
  reader: DatasetAdapter,
  workspace: string,
  nodeId: string,
  headId: string,
): Promise<Ancestry> {
  const rows: RevisionRow[] = [];
  const encoded: Record<string, unknown>[] = [];
  let wireBytes = EMPTY_ARRAY_BYTES;
  const seen = new Set<string>();

  let cursor: string | null = headId;
  while (cursor !== null) {
    if (seen.has(cursor)) failPublication("integrity_failure"); // cycle
    seen.add(cursor);
    if (rows.length >= MAX_CHAIN_ROWS) failPublication("limit_exceeded");

    const row = await findRevisionById(reader, workspace, cursor);
    if (row === null) failPublication("integrity_failure"); // missing ancestor
    if (row.node_id !== nodeId) failPublication("integrity_failure"); // cross-node
    if (row.workspace_name !== workspace) failPublication("integrity_failure");

    const encodedRow = decodeVerifiedRevision(row);
    const ordinal = parseInt64Text(encodedRow.revision_no);
    if (ordinal <= 0n) failPublication("integrity_failure");

    // Cumulative accounting, checked before accepting the row.
    wireBytes += revisionWireBytes(encodedRow) + (rows.length > 0 ? 1 : 0);
    if (wireBytes > MAX_CHAIN_WIRE_BYTES) failPublication("limit_exceeded");

    rows.push(row);
    encoded.push(encodedRow);

    const base = encodedRow.base_revision_id;
    cursor = base === null ? null : (base as string);
  }

  rows.reverse();
  encoded.reverse();

  // Ordinals must be exactly 1..n with the first having a null base.
  for (let i = 0; i < encoded.length; i++) {
    const ordinal = parseInt64Text(encoded[i]!.revision_no);
    if (ordinal !== BigInt(i + 1)) failPublication("integrity_failure");
    if (i === 0 && encoded[i]!.base_revision_id !== null) failPublication("integrity_failure");
  }
  return { rows, encoded, wireBytes };
}

// ── scoped reference validation (contract section 5) ────────────────────────
//
// Every reference resolves WITHIN the requesting workspace, and each lookup
// distinguishes 0 / 1 / >1 rather than taking the first match: a duplicate
// logical identity is stored corruption, not a tie to break.

const RESERVED_TYPE_VOCABULARY = "type";
const MEMORY_HORIZON_VOCABULARY = "memory_horizon";

async function requireExactlyOne(
  adapter: DatasetAdapter,
  table: string,
  predicate: string,
  path: string,
): Promise<Record<string, unknown>> {
  const rows = await adapter.query(table, predicate);
  if (rows.length === 0) failPublication("invalid_reference", path);
  if (rows.length > 1) failPublication("integrity_failure", path);
  return rows[0]!;
}

/** Peers, session and workspace: each exactly one scoped row when present. */
async function validateDomainReferences(
  adapter: DatasetAdapter,
  workspace: string,
  encoded: Record<string, unknown>,
): Promise<void> {
  await requireExactlyOne(adapter, "workspaces", `name = ${quote(workspace)}`, "/content/workspace_name");

  for (const field of ["author_peer_name", "observer_peer_name", "subject_peer_name"] as const) {
    const value = encoded[field];
    if (value === null) continue;
    await requireExactlyOne(
      adapter,
      "peers",
      `workspace_name = ${quote(workspace)} AND name = ${quote(value as string)}`,
      `/content/${field}`,
    );
  }
  if (encoded.session_name !== null) {
    await requireExactlyOne(
      adapter,
      "sessions",
      `workspace_name = ${quote(workspace)} AND name = ${quote(encoded.session_name as string)}`,
      "/content/session_name",
    );
  }
}

type TermSnapshotEntry = {
  term_id: string;
  vocabulary_id: string;
  vocabulary_name_snapshot: string;
  term_name_snapshot: string;
  label_snapshot: string | null;
};

function parseSnapshotArray(text: unknown, path: string): Record<string, unknown>[] {
  if (typeof text !== "string") failPublication("integrity_failure", path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failPublication("integrity_failure", path);
  }
  if (!Array.isArray(parsed)) failPublication("integrity_failure", path);
  return parsed as Record<string, unknown>[];
}

/**
 * Terms, vocabularies and workspace policy for NEW content.
 *
 * Historical accepted rows are validated against their OWN frozen snapshots
 * elsewhere; this runs only for a new publication or an unpublished-orphan
 * resumption, so a term renamed or retired later never invalidates history.
 */
async function validateTermReferences(
  adapter: DatasetAdapter,
  workspace: string,
  encoded: Record<string, unknown>,
): Promise<void> {
  const entries = parseSnapshotArray(encoded.term_snapshot_json, "/content/term_snapshot_json");
  const seenVocabularies = new Map<string, Record<string, unknown>>();
  const assignmentsByVocabulary = new Map<string, number>();
  let reservedTypeAssignments = 0;
  let horizonAssignments = 0;

  for (const raw of entries) {
    const entry = raw as unknown as TermSnapshotEntry;
    // label_snapshot MUST be null for NEW content: Term has no authoritative
    // label column, and Vocabulary.label names a VOCABULARY, not a term.
    // Conflating them would fabricate provenance.
    if (entry.label_snapshot !== null && entry.label_snapshot !== undefined) {
      failPublication("invalid_request", "/content/term_snapshot_json");
    }

    const term = await requireExactlyOne(
      adapter,
      "terms",
      `workspace_name = ${quote(workspace)} AND id = ${quote(entry.term_id)}`,
      "/content/term_snapshot_json",
    );
    if (term.vocabulary_id !== entry.vocabulary_id) {
      failPublication("invalid_reference", "/content/term_snapshot_json");
    }
    // A NEW assignment requires an ACTIVE term; retired terms stay readable
    // in history but cannot be newly assigned.
    if (term.is_active !== true) failPublication("invalid_reference", "/content/term_snapshot_json");
    if (term.name !== entry.term_name_snapshot) {
      failPublication("invalid_reference", "/content/term_snapshot_json");
    }

    let vocabulary = seenVocabularies.get(entry.vocabulary_id);
    if (vocabulary === undefined) {
      vocabulary = await requireExactlyOne(
        adapter,
        "vocabularies",
        `workspace_name = ${quote(workspace)} AND id = ${quote(entry.vocabulary_id)}`,
        "/content/term_snapshot_json",
      );
      seenVocabularies.set(entry.vocabulary_id, vocabulary);
    }
    if (vocabulary.name !== entry.vocabulary_name_snapshot) {
      failPublication("invalid_reference", "/content/term_snapshot_json");
    }
    // NOTE: a SEALED vocabulary still permits assigning an existing active
    // term. Sealing governs term CREATION, not assignment.
    if (vocabulary.kind !== "tags" && vocabulary.kind !== "categories") {
      failPublication("integrity_failure", "/content/term_snapshot_json");
    }
    if (vocabulary.cardinality !== "one" && vocabulary.cardinality !== "many") {
      failPublication("integrity_failure", "/content/term_snapshot_json");
    }

    const count = (assignmentsByVocabulary.get(entry.vocabulary_id) ?? 0) + 1;
    assignmentsByVocabulary.set(entry.vocabulary_id, count);
    if (vocabulary.cardinality === "one" && count > 1) {
      failPublication("invalid_request", "/content/term_snapshot_json");
    }
    if (vocabulary.name === RESERVED_TYPE_VOCABULARY) reservedTypeAssignments += 1;
    if (vocabulary.name === MEMORY_HORIZON_VOCABULARY) horizonAssignments += 1;
  }

  // Reserved constraints hold even if policy columns were configured loosely.
  const typeVocabularies = await adapter.query(
    "vocabularies",
    `workspace_name = ${quote(workspace)} AND name = ${quote(RESERVED_TYPE_VOCABULARY)}`,
  );
  if (typeVocabularies.length !== 1) failPublication("integrity_failure", "/content/term_snapshot_json");
  if (reservedTypeAssignments !== 1) failPublication("invalid_request", "/content/term_snapshot_json");

  const horizonVocabularies = await adapter.query(
    "vocabularies",
    `workspace_name = ${quote(workspace)} AND name = ${quote(MEMORY_HORIZON_VOCABULARY)}`,
  );
  if (horizonVocabularies.length > 1) failPublication("integrity_failure", "/content/term_snapshot_json");
  if (horizonAssignments > 1) failPublication("invalid_request", "/content/term_snapshot_json");

  // Every required=true workspace vocabulary needs at least one assignment.
  const allVocabularies = await adapter.query("vocabularies", `workspace_name = ${quote(workspace)}`);
  for (const vocabulary of allVocabularies) {
    if (vocabulary.required !== true) continue;
    if ((assignmentsByVocabulary.get(vocabulary.id as string) ?? 0) < 1) {
      failPublication("invalid_request", "/content/term_snapshot_json");
    }
  }
}

/** Internal link kinds resolve within W; external locators stay passive. */
async function validateLinkReferences(
  adapter: DatasetAdapter,
  workspace: string,
  nodeId: string,
  encoded: Record<string, unknown>,
): Promise<void> {
  const entries = parseSnapshotArray(encoded.link_snapshot_json, "/content/link_snapshot_json");
  const path = "/content/link_snapshot_json";

  for (const entry of entries) {
    const kind = entry.target_kind;
    const target = entry.target as Record<string, unknown> | null;
    if (kind === "node_revision") {
      const targetNodeId = target?.node_id as string | undefined;
      const targetRevisionId = target?.revision_id as string | undefined;
      if (typeof targetNodeId !== "string" || typeof targetRevisionId !== "string") {
        failPublication("invalid_reference", path);
      }
      const targetNode = await requireExactlyOne(
        adapter,
        "nodes",
        `workspace_name = ${quote(workspace)} AND id = ${quote(targetNodeId)}`,
        path,
      );
      const head = targetNode.current_revision_id;
      if (typeof head !== "string") failPublication("invalid_reference", path);
      // The target revision must be in the target node's ACCEPTED ancestry;
      // a row merely existing in the table is not a valid reference.
      const ancestry = await walkAncestry(adapter, workspace, targetNodeId, head);
      if (!ancestry.encoded.some((row) => row.id === targetRevisionId)) {
        failPublication("invalid_reference", path);
      }
      // NO blanket same-node ban. The contract requires the target revision
      // to be in the target node's ACCEPTED ancestry, and that already
      // excludes the revision now being created -- it is not accepted yet.
      // A reference to an earlier ACCEPTED revision of the same node is
      // legitimate, so rejecting it outright was an invented restriction.
      continue;
    }
    if (kind === "message") {
      // Canonical key names come from the protected codec's TARGET_KEYS:
      // message is (session_name, message_public_id). Reading `public_id`
      // here was an invented spelling that silently matched nothing.
      const sessionName = target?.session_name as string | undefined;
      const publicId = target?.message_public_id as string | undefined;
      if (typeof sessionName !== "string" || typeof publicId !== "string") {
        failPublication("invalid_reference", path);
      }
      await requireExactlyOne(
        adapter,
        "sessions",
        `workspace_name = ${quote(workspace)} AND name = ${quote(sessionName)}`,
        path,
      );
      await requireExactlyOne(
        adapter,
        "messages",
        `workspace_name = ${quote(workspace)} AND session_name = ${quote(sessionName)} AND public_id = ${quote(publicId)}`,
        path,
      );
      continue;
    }
    if (kind === "session") {
      // TARGET_KEYS.session is ["session_name"], not "name".
      const name = target?.session_name as string | undefined;
      if (typeof name !== "string") failPublication("invalid_reference", path);
      await requireExactlyOne(
        adapter,
        "sessions",
        `workspace_name = ${quote(workspace)} AND name = ${quote(name)}`,
        path,
      );
      continue;
    }
    if (kind === "trace") {
      // TARGET_KEYS.trace is ["trace_id"], not "id".
      const id = target?.trace_id as string | undefined;
      if (typeof id !== "string") failPublication("invalid_reference", path);
      await requireExactlyOne(
        adapter,
        "traces",
        `workspace_name = ${quote(workspace)} AND id = ${quote(id)}`,
        path,
      );
      continue;
    }
    // Every other kind is a validated PASSIVE external locator. Nothing is
    // fetched, no model is called and no capture truth is asserted: the byte
    // and shape contract was already checked by the governed codec.
  }
}

/** Validity interval, checked only when BOTH bounds are present. */
function validateValidity(encoded: Record<string, unknown>): void {
  const from = encoded.valid_from;
  const to = encoded.valid_to;
  if (typeof from !== "string" || typeof to !== "string") return;
  if (timestampToMicros(from) >= timestampToMicros(to)) {
    failPublication("invalid_request", "/content/valid_from");
  }
}

/** All NEW-content reference checks, run before any append. */
async function validateNewContent(
  adapter: DatasetAdapter,
  workspace: string,
  nodeId: string,
  encoded: Record<string, unknown>,
): Promise<void> {
  validateValidity(encoded);
  await validateDomainReferences(adapter, workspace, encoded);
  await validateTermReferences(adapter, workspace, encoded);
  await validateLinkReferences(adapter, workspace, nodeId, encoded);
}

// ── service ─────────────────────────────────────────────────────────────────

export type PublicationReaderService = {
  getAcceptedHead(requestBytes: Uint8Array): Promise<unknown>;
  listAcceptedHistory(requestBytes: Uint8Array): Promise<unknown>;
};

export type PublicationWriterService = PublicationReaderService & {
  publishRevision(requestBytes: Uint8Array): Promise<PublishOutcome>;
  close(): Promise<void>;
};

async function readHeadAndAncestry(reader: DatasetAdapter, request: ReadRequest) {
  // Nodes FIRST, then revisions: once the head is captured it stays the
  // reference for this read even if a writer advances it, and immutable rows
  // keep the old chain complete and valid.
  await reader.refresh("nodes");
  const node = await findNode(reader, request.workspace_name, request.node_id);
  if (node === null) return null;

  const encodedNode = encodeNodeRow(node);
  const headId = encodedNode.current_revision_id;
  // A headless physical node is an integrity failure, NOT the absent result.
  if (typeof headId !== "string") failPublication("integrity_failure");

  await reader.refresh("node_revisions");
  const ancestry = await walkAncestry(reader, request.workspace_name, request.node_id, headId);
  return { node: encodedNode, headId, ancestry };
}

function makeReadMethods(reader: DatasetAdapter): PublicationReaderService {
  return {
    async getAcceptedHead(requestBytes: Uint8Array) {
      const request = parseReadRequest(requestBytes);
      const found = await readHeadAndAncestry(reader, request);
      if (found === null) return null; // absent node: exactly null
      const head = found.ancestry.encoded.at(-1);
      if (head === undefined) failPublication("integrity_failure");
      return { node: found.node, revision: head };
    },

    async listAcceptedHistory(requestBytes: Uint8Array) {
      const request = parseReadRequest(requestBytes);
      const found = await readHeadAndAncestry(reader, request);
      if (found === null) return null;
      return {
        node: found.node,
        // Named for THIS read's captured head, not a promise about later ones.
        snapshot_head_revision_id: found.headId,
        revisions: found.ancestry.encoded,
      };
    },
  };
}

/**
 * Read-only service. PRIVATE: it accepts an adapter, and exporting it would
 * hand a caller a way to supply their own and bypass construction.
 */
function createPublicationReaderService(reader: DatasetAdapter): PublicationReaderService {
  return Object.freeze(makeReadMethods(reader));
}

/**
 * Writer service. Serialises every request through one promise queue, so two
 * operations cannot interleave inside a single process even though the
 * external gate already excludes other processes.
 */
/**
 * Writer service. PRIVATE for the same reason as the reader factory: the
 * only supported construction is `openPublicationWriter`.
 */
/**
 * The one module-private owner.
 *
 * Serial write queue, attempted-write tracking, fail-stop poison, released
 * state and the one-shot close live HERE rather than in a facade, so
 * publication and taxonomy genuinely SHARE them: a failure in either poisons
 * later writes in both. Nothing here is exported and nothing accepts
 * caller-asserted authority.
 */
type OwnerCore = {
  serial: <T>(work: () => Promise<T>) => Promise<T>;
  boundary: (name: PublicationBoundary, wroteAlready: boolean) => Promise<void>;
  taxonomyBoundary: (name: TaxonomyBoundary, wroteAlready: boolean) => Promise<void>;
  contextBoundary: (name: ContextBoundary, wroteAlready: boolean) => Promise<void>;
  markAttemptedWrite: () => void;
  afterWrite: <T>(work: () => Promise<T>) => Promise<T>;
  poison: () => void;
  close: () => Promise<void>;
};

/**
 * Is this an error WE deliberately raised, rather than an unknown failure?
 *
 * Exact types only. Matching on a `name` or `code` property would let any
 * object shaped like an error escape normalization.
 */
function isSafeContractError(error: unknown): boolean {
  // `instanceof` against the ACTUAL classes.
  //
  // The protected `isContractError` helper matches on `name` alone, which is
  // duck typing: measured, isContractError({name:"ContractError"}) is true.
  // Using it here would let any object shaped like a contract error escape
  // normalization and carry its raw text out through the boundary. The
  // protected helper is left untouched -- it has its own callers and its own
  // contract; it is simply the wrong tool for a trust decision.
  return (
    error instanceof PublicationError ||
    error instanceof TaxonomyError ||
    error instanceof ContractError
  );
}

function createOwnerCore(
  writer: DatasetAdapter,
  hooks: {
    onBoundary?: BoundaryHook;
    onTaxonomyBoundary?: TaxonomyBoundaryHook;
    onContextBoundary?: ContextBoundaryHook;
  },
): OwnerCore {
  let queue: Promise<unknown> = Promise.resolve();
  /** Fail-stop: once poisoned, no further queued mutation may run. */
  let poisoned = false;
  /** Set by close(): work queued after it is rejected, not silently run. */
  let closing = false;
  /**
   * The ONE close, cached.
   *
   * A descriptor NUMBER is a reusable integer, not an identity. Once the
   * inherited gate descriptor is released the kernel may hand that same number
   * back for something entirely unrelated, so releasing on every call would
   * eventually close a descriptor this writer never owned. Caching the promise
   * also makes concurrent closes drain the queue once and settle together.
   */
  let closeOnce: Promise<void> | undefined;

  /**
   * Await the fault-test hook at a commanded boundary.
   *
   * `wroteAlready` matters: a hook that throws after any attempted write
   * leaves durable state this owner can no longer reason about, so it takes
   * the same fail-stop path as any other ambiguous post-write failure.
   */
  const runHook = async (
    hook: ((name: string) => Promise<void>) | undefined,
    name: string,
    wroteAlready: boolean,
  ): Promise<void> => {
    if (hook === undefined) return;
    try {
      await hook(name);
    } catch {
      if (wroteAlready) {
        poisoned = true;
        failPublication("recovery_required");
      }
      failPublication("invalid_request");
    }
  };

  const boundary = (name: PublicationBoundary, wroteAlready: boolean): Promise<void> =>
    runHook(hooks.onBoundary as ((n: string) => Promise<void>) | undefined, name, wroteAlready);

  const taxonomyBoundary = (name: TaxonomyBoundary, wroteAlready: boolean): Promise<void> =>
    runHook(hooks.onTaxonomyBoundary as ((n: string) => Promise<void>) | undefined, name, wroteAlready);

  const contextBoundary = (name: ContextBoundary, wroteAlready: boolean): Promise<void> =>
    runHook(hooks.onContextBoundary as ((n: string) => Promise<void>) | undefined, name, wroteAlready);

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(async () => {
      // Both gates checked INSIDE the queued turn, so a request enqueued
      // before close but reached after it is still rejected.
      if (poisoned) failPublication("recovery_required");
      if (closing) failPublication("recovery_required");
      attemptedWrite = false;
      try {
        return await work();
      } catch (error) {
        // THE boundary: if this operation had already attempted persistence,
        // any failure at all leaves durable state we cannot account for.
        // This catches write sites that forgot their own guard, which is
        // precisely how the node append and head update slipped through.
        if (attemptedWrite) {
          poisoned = true;
          // Classify here as well, not only poison. Steps that run after
          // durability but carry no wrapper of their own -- the post-append
          // node re-check at the fresh-publication site is one -- would
          // otherwise hand the caller a raw SDK rejection instead of the
          // ambiguous-window code the contract specifies. Doing it here keeps
          // the guarantee a property of the operation rather than something
          // each future write site has to remember.
          // Preserve DELIBERATELY raised safe contract errors; normalize only
          // genuinely unknown exceptions. Collapsing a thrown
          // integrity_failure into recovery_required would lose the
          // difference between "ambiguous" and "the stored row is
          // structurally invalid" -- different operator problems. This is an
          // exact list of our own error types, NOT a whitelist of any object
          // that happens to carry a name or a code.
          if (!isSafeContractError(error)) failPublication("recovery_required");
        }
        throw error;
      }
    });
    // Keep the chain alive regardless of this request's outcome.
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<T>;
  };

  /**
   * Whether the CURRENT serialized operation has attempted any persistence.
   *
   * One flag per operation, set immediately before each append or update,
   * rather than a catch around every call site. Scattered catches were how
   * the node append and the head update ended up unguarded while the
   * revision readback was covered: the guarantee has to be a property of the
   * operation, not something each new write site remembers to opt into.
   */
  let attemptedWrite = false;

  /** Mark persistence as attempted. Call IMMEDIATELY before any write. */
  const markAttemptedWrite = (): void => {
    attemptedWrite = true;
  };

  /**
   * Run post-write work, poisoning the owner if anything goes wrong.
   *
   * Once anything is durably written, every later step is inside the
   * ambiguous window contract section 7 describes. Deliberately scoped to
   * AFTER an attempted write: pre-write validation errors leave nothing
   * behind and must keep the owner usable.
   */
  const afterWrite = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      poisoned = true;
      if (isSafeContractError(error)) throw error;
      return failPublication("recovery_required");
    }
  };

  return {
    serial,
    boundary,
    taxonomyBoundary,
    contextBoundary,
    markAttemptedWrite,
    afterWrite,
    poison: () => {
      poisoned = true;
    },
    /**
     * Close: stop accepting work, drain what is in flight, then RELEASE the
     * gate -- including the inherited descriptor. Deleting the in-process
     * registry entry is not enough: the flock lives on fd 42.
     *
     * One-shot (#46): a descriptor NUMBER is reusable, so a second release
     * would close a descriptor this owner never held.
     */
    close: () => {
      closeOnce ??= (async () => {
        closing = true;
        await queue.catch(() => undefined);
        writer.release();
        releaseInheritedGate();
      })();
      return closeOnce;
    },
  };
}

function createPublicationWriterService(
  writer: DatasetAdapter,
  options: { clock: Clock; newRevisionId: IdSource },
  core: OwnerCore,
): PublicationWriterService {
  const reads = makeReadMethods(writer);
  const { afterWrite, boundary, markAttemptedWrite, poison, serial } = core;

  const publish = async (requestBytes: Uint8Array): Promise<PublishOutcome> => {
    const outer = parseRequest(requestBytes);
    closedKeys(outer, ["operation_id", "content"], "");
    const operationId = requireOperationId(outer.get("operation_id"), "/operation_id");
    const content = outer.get("content") as JcsValue;

    // The governed codec owns envelope validation and the canonical bytes.
    // Its failures keep the arra-error/v1 envelope untouched.
    let validated: RevisionResult;
    try {
      validated = revisionOp(content, ["content"]);
    } catch (error) {
      if (isContractError(error)) throw error;
      return failPublication("invalid_request", "/content");
    }

    // `RevisionColumns` carries only the five NORMALIZED JSON columns, so the
    // remaining envelope fields are read from the content map that revisionOp
    // has already validated -- not re-derived and not re-validated loosely.
    if (!(content instanceof Map)) failPublication("invalid_request", "/content");
    const envelope = content as JcsObject;
    const workspace = requireWorkspaceName(envelope.get("workspace_name"), "/content/workspace_name");
    const nodeId = requireNodeId(envelope.get("node_id"), "/content/node_id");
    const rawBase = envelope.get("base_revision_id");
    const baseRevisionId = rawBase === null || rawBase === undefined ? null : requireNodeId(rawBase, "/content/base_revision_id");

    await writer.refresh("node_revisions");
    const existingOperation = await findOperation(writer, workspace, operationId);

    if (existingOperation !== null) {
      // Operation lookup OUTRANKS a stale current base on an accepted retry.
      const encoded = encodeRevisionRow(existingOperation);
      if (encoded.content_digest !== validated.content_digest) {
        // A changed payload under the same key is a classification, not
        // invalid bytes.
        return { outcome: "conflict", reason: "operation_digest" };
      }
      if (encoded.node_id !== nodeId) failPublication("integrity_failure");

      await writer.refresh("nodes");
      const node = await findNode(writer, workspace, nodeId);
      if (node !== null) {
        const encodedNode = encodeNodeRow(node);
        const headId = encodedNode.current_revision_id;
        if (typeof headId !== "string") failPublication("integrity_failure");
        const ancestry = await walkAncestry(writer, workspace, nodeId, headId);
        const reachable = ancestry.encoded.some((row) => row.id === encoded.id);
        if (reachable) {
          // The ORIGINAL values, even if a later head now exists.
          return {
            outcome: "idempotent",
            node_id: nodeId,
            revision_id: encoded.id as string,
            revision_no: encoded.revision_no as string,
            content_digest: encoded.content_digest as string,
            node_created_at: encodedNode.created_at as string,
            revision_created_at: encoded.created_at as string,
          };
        }
      }
      // Same digest but unpublished: an orphan awaiting resumption. Resuming
      // reuses the STORED id/ordinal/timestamp; it never allocates a new row.
      return await resumeOrphan(encoded, workspace, nodeId, baseRevisionId);
    }

    return await publishFresh(validated, envelope, workspace, nodeId, baseRevisionId, operationId);
  };

  /** Resume a same-operation orphan, or classify why it cannot resume. */
  const resumeOrphan = async (
    encoded: Record<string, unknown>,
    workspace: string,
    nodeId: string,
    _baseRevisionId: string | null,
  ): Promise<PublishOutcome> => {
    // A resuming orphan is still NEW publication for reference purposes:
    // re-validate against present policy before it becomes visible.
    await validateNewContent(writer, workspace, nodeId, encoded);

    await writer.refresh("nodes");
    const node = await findNode(writer, workspace, nodeId);
    const storedBase = encoded.base_revision_id;

    if (node === null) {
      if (storedBase !== null) failPublication("integrity_failure");
      // Resume ONLY if no OTHER revision claims this node id.
      //
      // The previous version checked the stored base and nothing else, so a
      // rival operation's orphan on the same absent node was simply adopted
      // -- the resuming operation took over a disputed identity. Uniqueness
      // of the scoped claim is what decides this; we do not pick a winner.
      await writer.refresh("node_revisions");
      const claims = await writer.query(
        "node_revisions",
        `workspace_name = ${quote(workspace)} AND node_id = ${quote(nodeId)}`,
      );
      const rivals = claims.filter((row) => row.id !== encoded.id);
      if (rivals.length > 0) {
        // Leave the orphan hidden rather than publishing over a contender.
        return { outcome: "conflict", reason: "node_id" };
      }
      return await headNodeAtRevision(encoded, workspace, nodeId);
    }
    const encodedNode = encodeNodeRow(node);
    const headId = encodedNode.current_revision_id;
    if (typeof headId !== "string") failPublication("integrity_failure");
    // An existing-node orphan resumes only when the head still equals its base.
    if (headId !== storedBase) return { outcome: "conflict", reason: "stale_base" };
    return await advanceHead(encoded, workspace, nodeId, headId, encodedNode);
  };

  const publishFresh = async (
    validated: RevisionResult,
    envelope: JcsObject,
    workspace: string,
    nodeId: string,
    baseRevisionId: string | null,
    operationId: string,
  ): Promise<PublishOutcome> => {
    await writer.refresh("nodes");
    const node = await findNode(writer, workspace, nodeId);

    if (baseRevisionId === null) {
      if (node !== null) {
        // A node with a NULL head has unknown provenance: this slice creates
        // none, so something else allocated it and we cannot tell what. That
        // is integrity_failure, NOT a node_id conflict -- reporting a
        // conflict would imply a legitimate rival claim and invite a retry
        // against state nobody can account for. Checked BEFORE classifying.
        if (encodeNodeRow(node).current_revision_id === null) {
          failPublication("integrity_failure");
        }
        return { outcome: "conflict", reason: "node_id" };
      }
      // Another operation's orphan may already claim this node ID.
      const claims = await writer.query(
        "node_revisions",
        `workspace_name = ${quote(workspace)} AND node_id = ${quote(nodeId)}`,
      );
      if (claims.length > 0) return { outcome: "conflict", reason: "node_id" };
      await validateNewContent(writer, workspace, nodeId, encodeEnvelopeForChecks(validated, envelope));
      return await createFirstRevision(validated, envelope, workspace, nodeId, operationId);
    }

    // State error, not a request-pointer error: section 8 puts read/state
    // failures at path "". A missing REFERENCED peer or session still points
    // at its content field; an absent node does not.
    if (node === null) failPublication("not_found", "");
    const encodedNode = encodeNodeRow(node);
    // Same unknown-provenance rule on the append path.
    if (encodedNode.current_revision_id === null) failPublication("integrity_failure");
    const headId = encodedNode.current_revision_id;
    if (typeof headId !== "string") failPublication("integrity_failure");
    if (headId !== baseRevisionId) return { outcome: "conflict", reason: "stale_base" };
    await validateNewContent(writer, workspace, nodeId, encodeEnvelopeForChecks(validated, envelope));
    return await appendRevision(validated, envelope, workspace, nodeId, headId, encodedNode, operationId);
  };

  // The write paths below are intentionally explicit about ordering; see
  // contract section 7. Each one fail-stops rather than guessing.

  const createFirstRevision = async (
    validated: RevisionResult,
    envelope: JcsObject,
    workspace: string,
    nodeId: string,
    operationId: string,
  ): Promise<PublishOutcome> => {
    const createdAtMs = options.clock();
    const createdAt = new Date(createdAtMs).toISOString();
    const revisionId = options.newRevisionId();
    const built = buildRevisionRow(validated, envelope, {
      revisionId,
      workspace,
      nodeId,
      operationId,
      revisionNo: 1n,
      baseRevisionId: null,
      createdAt,
    });
    await appendAndVerify(built, workspace, revisionId, operationId);

    // Recheck absence under the SAME writer ownership before heading a node.
    await writer.refresh("nodes");
    if ((await findNode(writer, workspace, nodeId)) !== null) {
      return { outcome: "conflict", reason: "node_id" };
    }
    const nodeRow = {
      id: nodeId,
      workspace_name: workspace,
      current_revision_id: revisionId,
      // Node timestamps come from the stored revision, not a second sample.
      created_at: BigInt(createdAtMs) * 1000n,
      updated_at: BigInt(createdAtMs) * 1000n,
    };
    markAttemptedWrite();
    await afterWrite(async () => {
      await writer.append("nodes", [nodeRow]);
    });
    await boundary("after_head_publication", true);
    await verifyFinalState(workspace, nodeId, revisionId);
    return {
      outcome: "accepted",
      node_id: nodeId,
      revision_id: revisionId,
      revision_no: "1",
      content_digest: validated.content_digest,
      node_created_at: createdAt,
      revision_created_at: createdAt,
    };
  };

  const appendRevision = async (
    validated: RevisionResult,
    envelope: JcsObject,
    workspace: string,
    nodeId: string,
    headId: string,
    encodedNode: Record<string, unknown>,
    operationId: string,
  ): Promise<PublishOutcome> => {
    const ancestry = await walkAncestry(writer, workspace, nodeId, headId);
    const headEncoded = ancestry.encoded.at(-1);
    if (headEncoded === undefined) failPublication("integrity_failure");
    const nextOrdinal = parseInt64Text(headEncoded.revision_no) + 1n;

    const createdAtMs = options.clock();
    const createdAt = new Date(createdAtMs).toISOString();
    const revisionId = options.newRevisionId();
    const built = buildRevisionRow(validated, envelope, {
      revisionId,
      workspace,
      nodeId,
      operationId,
      revisionNo: nextOrdinal,
      baseRevisionId: headId,
      createdAt,
    });

    // Budget the prospective row against the existing chain before appending.
    const prospective = ancestry.wireBytes + revisionWireBytes(built.wire) + 1;
    if (prospective > MAX_CHAIN_WIRE_BYTES) failPublication("limit_exceeded");
    if (ancestry.rows.length + 1 > MAX_CHAIN_ROWS) failPublication("limit_exceeded");

    await appendAndVerify(built, workspace, revisionId, operationId);
    return await advanceHeadTo(
      workspace,
      nodeId,
      headId,
      revisionId,
      createdAtMs,
      validated.content_digest,
      nextOrdinal.toString(10),
      encodedNode.created_at as string,
      createdAt,
    );
  };

  const headNodeAtRevision = async (
    encoded: Record<string, unknown>,
    workspace: string,
    nodeId: string,
  ): Promise<PublishOutcome> => {
    const createdAt = encoded.created_at as string;
    const nodeRow = {
      id: nodeId,
      workspace_name: workspace,
      current_revision_id: encoded.id as string,
      created_at: writableTimestamp(createdAt),
      updated_at: writableTimestamp(createdAt),
    };
    markAttemptedWrite();
    await afterWrite(async () => {
      await writer.append("nodes", [nodeRow]);
    });
    await boundary("after_head_publication", true);
    await verifyFinalState(workspace, nodeId, encoded.id as string);
    return {
      outcome: "accepted",
      node_id: nodeId,
      revision_id: encoded.id as string,
      revision_no: encoded.revision_no as string,
      content_digest: encoded.content_digest as string,
      node_created_at: createdAt,
      revision_created_at: createdAt,
    };
  };

  const advanceHead = async (
    encoded: Record<string, unknown>,
    workspace: string,
    nodeId: string,
    headId: string,
    encodedNode: Record<string, unknown>,
  ): Promise<PublishOutcome> =>
    advanceHeadTo(
      workspace,
      nodeId,
      headId,
      encoded.id as string,
      Number(timestampToMicros(encoded.created_at as string) / 1000n),
      encoded.content_digest as string,
      encoded.revision_no as string,
      encodedNode.created_at as string,
      encoded.created_at as string,
    );

  const advanceHeadTo = async (
    workspace: string,
    nodeId: string,
    expectedHeadId: string,
    newHeadId: string,
    updatedAtMs: number,
    digest: string,
    revisionNo: string,
    nodeCreatedAt: string,
    revisionCreatedAt: string,
  ): Promise<PublishOutcome> => {
    // The head update is persistence: refresh and update are both inside the
    // attempted-write window, so a thrown SDK rejection here poisons.
    markAttemptedWrite();
    const { rowsUpdated } = await afterWrite(async () => {
      await writer.refresh("nodes");
      return writer.updateWhere(
      "nodes",
      `workspace_name = ${quote(workspace)} AND id = ${quote(nodeId)} AND current_revision_id = ${quote(expectedHeadId)}`,
      {
        current_revision_id: quote(newHeadId),
        // Microseconds as an exact integer literal cast to the column's own
        // timestamp[us] type. `updatedAtMs * 1000` in JS floating point could
        // lose exactness at the top of the range, so the multiply is BigInt.
        updated_at: `CAST(${(BigInt(updatedAtMs) * 1000n).toString(10)} AS TIMESTAMP(6))`,
      },
      );
    });
    // Anything but exactly one row is ambiguous: fail-stop, never guess.
    if (rowsUpdated !== 1) {
      poison();
      failPublication("recovery_required");
    }
    await boundary("after_head_publication", true);
    await verifyFinalState(workspace, nodeId, newHeadId);
    return {
      outcome: "accepted",
      node_id: nodeId,
      revision_id: newHeadId,
      revision_no: revisionNo,
      content_digest: digest,
      node_created_at: nodeCreatedAt,
      revision_created_at: revisionCreatedAt,
    };
  };

  /** Append one row, then read it back by BOTH scoped identities. */
  const appendAndVerify = async (
    built: BuiltRevision,
    workspace: string,
    revisionId: string,
    operationId: string,
  ): Promise<void> => {
    await boundary("before_append", false);
    markAttemptedWrite();
    try {
      await writer.append("node_revisions", [built.physical]);
    } catch {
      poison();
      failPublication("recovery_required");
    }
    await boundary("after_revision_append", true);
    // From here on the row is durable: any failure is ambiguous.
    await afterWrite(async () => {
      await writer.refresh("node_revisions");
    });
    const byId = await afterWrite(() => findRevisionById(writer, workspace, revisionId));
    const byOperation = await afterWrite(() => findOperation(writer, workspace, operationId));
    if (byId === null || byOperation === null) {
      poison();
      failPublication("recovery_required");
    }
    // Compare the COMPLETE expected immutable row, field by field, not just
    // two digest strings: a digest match proves the content bytes agree, and
    // says nothing about the allocation state written alongside them.
    // A digest recompute failure here means the durable row does not match
    // what we believe we wrote: ambiguous, so it poisons rather than merely
    // reporting integrity_failure and leaving the owner usable.
    const storedById = await afterWrite(async () => decodeVerifiedRevision(byId));
    const storedByOperation = await afterWrite(async () => decodeVerifiedRevision(byOperation));
    const expected = built.wire;
    for (const field of Object.keys(expected)) {
      if (storedById[field] !== expected[field] || storedByOperation[field] !== expected[field]) {
        poison();
        failPublication("recovery_required");
      }
    }
    await boundary("after_revision_readback", true);
  };

  /** Fresh nodes-then-revisions readback of the whole accepted chain. */
  const verifyFinalState = async (workspace: string, nodeId: string, expectedHead: string) => {
    // Every step here runs after a durable write, so the whole body is
    // wrapped: a walkAncestry throw used to escape without poisoning.
    await afterWrite(async () => {
      await writer.refresh("nodes");
      const node = await findNode(writer, workspace, nodeId);
      if (node === null) failPublication("recovery_required");
      const encodedNode = encodeNodeRow(node);
      if (encodedNode.current_revision_id !== expectedHead) failPublication("recovery_required");
      await writer.refresh("node_revisions");
      await walkAncestry(writer, workspace, nodeId, expectedHead);
    });
  };

  return Object.freeze({
    ...reads,
    publishRevision: (requestBytes: Uint8Array) => serial(() => publish(requestBytes)),
    /**
     * Close: stop accepting work, drain what is in flight, then RELEASE the
     * gate -- including the inherited descriptor.
     *
     * Deleting the in-process registry entry is not enough: the flock lives
     * on fd 42, so until that descriptor is closed a contender still sees the
     * dataset as busy even though this owner is finished. Closing it is what
     * makes "close while the process stays alive" actually free the gate.
     */
    close: core.close,
  });
}

/**
 * The contracted factories.
 *
 * These are the ONLY publication entrypoints. Each returns a frozen object
 * carrying exactly the contracted methods -- no adapter, no connection, no
 * table and no caller-mintable owner handle escapes through them.
 */
export async function openPublicationReader(datasetRoot: string): Promise<PublicationReaderService> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  // Reading needs no gate, and this adapter exposes no mutator to the
  // read-only service built over it.
  const adapter = makeAdapter(await openPrivateConnection(canonical), () => {});
  return createPublicationReaderService(adapter);
}

export type OperatorOptions = {
  clock?: Clock;
  newRevisionId: IdSource;
  /** Trusted operator-only fault seam. Not request JSON, not an env hook. */
  onBoundary?: BoundaryHook;
  env?: NodeJS.ProcessEnv;
};

export async function openPublicationWriter(
  datasetRoot: string,
  options: OperatorOptions,
): Promise<PublicationWriterService> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  // Gate and single-owner claim BOTH precede connect, so a refused writer
  // never opens a writable connection at all.
  assertInheritedGate(canonical, options.env);
  if (OWNERS.has(canonical)) failPublication("writer_unavailable");
  const token = Symbol(canonical);
  OWNERS.set(canonical, token);

  let adapter: DatasetAdapter;
  try {
    adapter = makeAdapter(await openPrivateConnection(canonical), () => {
      if (OWNERS.get(canonical) === token) OWNERS.delete(canonical);
    });
  } catch (error) {
    OWNERS.delete(canonical);
    throw error;
  }

  const core = createOwnerCore(adapter, { onBoundary: options.onBoundary });
  return createPublicationWriterService(
    adapter,
    { clock: options.clock ?? Date.now, newRevisionId: options.newRevisionId },
    core,
  );
}

/**
 * The validated envelope as a flat encoded record, for reference checks.
 *
 * Uses the codec's NORMALIZED JSON columns rather than the raw request
 * strings, so the checks run against exactly what will be persisted.
 */
function encodeEnvelopeForChecks(
  validated: RevisionResult,
  envelope: JcsObject,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEYS) out[key] = envelope.get(key) ?? null;
  const columns = validated.columns as unknown as Record<string, unknown>;
  for (const key of ["fields", "term_snapshot_json", "link_snapshot_json", "h_metadata", "internal_metadata"]) {
    out[key] = columns[key] ?? null;
  }
  return out;
}

/**
 * Exact UTC-millisecond string to raw storage microseconds.
 *
 * Stays a BigInt all the way to the Arrow builder. A JS Number here would be
 * accepted and then silently corrupt: measured, 253402300799999000 reads back
 * as -4852116231934706.
 */
function writableTimestamp(text: string): bigint {
  return timestampToMicros(text);
}

/** Build a complete physical revision row from validated canonical columns. */
type BuiltRevision = {
  /** What goes to the SDK: Dates for timestamps, BigInts for Int64. */
  physical: Record<string, unknown>;
  /** What the row MUST read back as. Built from the same source values, so
   *  readback comparison never has to re-encode the Date-bearing write row. */
  wire: Record<string, unknown>;
};

function buildRevisionRow(
  validated: RevisionResult,
  envelope: JcsObject,
  allocation: {
    revisionId: string;
    workspace: string;
    nodeId: string;
    operationId: string;
    revisionNo: bigint;
    baseRevisionId: string | null;
    createdAt: string;
  },
): BuiltRevision {
  // Normalized JSON columns come from the codec; scalar envelope fields come
  // from the validated content map. Never the raw request strings.
  const c = validated.columns as unknown as Record<string, unknown>;
  const e = (key: string): unknown => envelope.get(key) ?? null;
  const micros = timestampToMicros(allocation.createdAt);
  const physical: Record<string, unknown> = {
    id: allocation.revisionId,
    workspace_name: allocation.workspace,
    node_id: allocation.nodeId,
    revision_no: allocation.revisionNo,
    base_revision_id: allocation.baseRevisionId,
    operation_id: allocation.operationId,
    title: e("title"),
    body: e("body"),
    body_format: e("body_format"),
    fields: c.fields,
    author_peer_name: e("author_peer_name"),
    observer_peer_name: e("observer_peer_name"),
    subject_peer_name: e("subject_peer_name"),
    session_name: e("session_name"),
    is_active: e("is_active"),
    // Raw microsecond BigInts, never Date: a Date round trip would drop
    // precision the timestamp[us] column can hold, and the read path
    // deliberately refuses Date for exactly that reason.
    valid_from: e("valid_from") === null ? null : writableTimestamp(e("valid_from") as string),
    valid_to: e("valid_to") === null ? null : writableTimestamp(e("valid_to") as string),
    change_reason: e("change_reason"),
    created_at: micros,
    schema_version: typeof e("schema_version") === "string" ? parseInt64Text(e("schema_version")) : 1n,
    canonical_version: (e("canonical_version") as string | null) ?? "arra-revision/v1",
    content_digest: validated.content_digest,
    term_snapshot_json: c.term_snapshot_json,
    link_snapshot_json: c.link_snapshot_json,
    h_metadata: c.h_metadata ?? null,
    internal_metadata: c.internal_metadata ?? null,
  };

  // The expected wire form, from the SAME values -- not a re-encode of the
  // physical row, whose Dates the read decoder deliberately refuses.
  const wire: Record<string, unknown> = {
    ...physical,
    revision_no: allocation.revisionNo.toString(10),
    schema_version: (physical.schema_version as bigint).toString(10),
    created_at: allocation.createdAt,
    valid_from: e("valid_from") === null ? null : (e("valid_from") as string),
    valid_to: e("valid_to") === null ? null : (e("valid_to") as string),
  };

  return { physical, wire };
}

export { PublicationError };

/* ------------------------------------------------------------------ *
 * Taxonomy persistence. Private to this module: taxonomy.ts stays pure.
 * ------------------------------------------------------------------ */

const VOCABULARIES = "vocabularies";
const TERMS = "terms";

/**
 * Translate an owner-core failure into the taxonomy envelope.
 *
 * The shared core speaks one internal language (`PublicationError`) because it
 * is shared; each facade presents its own envelope. Every publication code has
 * a taxonomy counterpart, so this is total and never invents a classification
 * -- it carries code and path across unchanged. Anything that is NOT a
 * PublicationError is rethrown untouched, so governed `arra-error/v1`
 * diagnostics still pass through.
 */
function asTaxonomyError(error: unknown): never {
  if (error instanceof PublicationError) {
    throw new TaxonomyError(error.code as TaxonomyErrorCode, error.path);
  }
  throw error;
}

/** Exactly one row at a scoped identity, or null. Never a first-match guess. */
async function scopedOne(
  adapter: DatasetAdapter,
  table: string,
  predicate: string,
): Promise<Record<string, unknown> | null> {
  const rows = await adapter.query(table, predicate);
  if (rows.length === 0) return null;
  // Multiple rows at an identity that must be unique is corruption. Picking
  // one would make a corrupt dataset look healthy.
  //
  // ROOT path, deliberately: this is a global stored-state failure, not a
  // complaint about the field the caller happened to send.
  if (rows.length > 1) failTaxonomy("integrity_failure", "");
  return rows[0]!;
}

const scopeOf = (workspace: string) => `workspace_name = ${quote(workspace)}`;

function createTaxonomyReadMethods(reader: DatasetAdapter) {
  /**
   * Reads need the same envelope translation the mutators get.
   *
   * The owner core raises PublicationError because it is SHARED, so a
   * released or otherwise unusable adapter surfaced
   * `arra-publication-error/v1` from a taxonomy call. The code is identical
   * in both envelopes, which is why asserting only the code never caught it.
   *
   * Governed ContractError from strict parsing passes through untouched:
   * asTaxonomyError rethrows anything that is not a PublicationError.
   */
  const read = <T>(work: () => Promise<T>): Promise<T> => work().catch(asTaxonomyError);

  return {
    getVocabulary(requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
      return read(async () => {
        const request = parseGetVocabulary(requestBytes);
        await reader.refresh(VOCABULARIES);
        const row = await scopedOne(
          reader,
          VOCABULARIES,
          `${scopeOf(request.workspace_name)} AND id = ${quote(request.vocabulary_id)}`,
        );
        return row === null ? null : encodeVocabularyRow(row);
      });
    },

    getTerm(requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
      return read(async () => {
        const request = parseGetTerm(requestBytes);
        await reader.refresh(TERMS);
        // A staged term stays visible even when its vocabulary is absent: that
        // is a legitimate resume state, not corruption, and hiding it would
        // make a partial seed look like a fresh one.
        const row = await scopedOne(
          reader,
          TERMS,
          `${scopeOf(request.workspace_name)} AND id = ${quote(request.term_id)}`,
        );
        return row === null ? null : encodeTermRow(row);
      });
    },
  };
}

type TaxonomyRow = Record<string, unknown>;
type MutationOutcome = { outcome: "created" | "already_satisfied" | "updated"; row: TaxonomyRow };

/**
 * Compare a stored row against the state we would have written.
 *
 * `created_at` is EXCLUDED: an existing row keeps its own validated allocation
 * time, and a retry must never refresh it. Everything else must match exactly,
 * so a renamed or retired row conflicts rather than being silently repaired.
 */
function sameExcept(stored: TaxonomyRow, expected: TaxonomyRow, fields: readonly string[]): boolean {
  for (const field of fields) {
    if (field === "created_at") continue;
    if (stored[field] !== expected[field]) return false;
  }
  return true;
}

function createTaxonomyWriterService(
  writer: DatasetAdapter,
  core: OwnerCore,
  options: { clock: Clock },
) {
  const reads = createTaxonomyReadMethods(writer);

  /** Run a mutation on the SHARED queue, presenting the taxonomy envelope. */
  const mutate = <T>(work: () => Promise<T>): Promise<T> =>
    core.serial(work).catch(asTaxonomyError);

  /**
   * Persist one row and prove it landed.
   *
   * Boundary order is frozen PER ROW: `before_write` immediately before the
   * attempted SDK call, then exactly ONE success boundary, then the readback
   * verification, then one `after_readback`. The attempted-write flag is set
   * immediately before the SDK call and NOT before the hook, so a hook failure
   * on a first row leaves the owner usable while a hook failure after an
   * earlier attempted row still poisons.
   *
   * A failed SDK call or a failed verification emits no later success boundary.
   */
  const writeRow = async (
    table: string,
    row: TaxonomyRow,
    successBoundary: TaxonomyBoundary,
    wroteAlready: boolean,
  ): Promise<void> => {
    await core.taxonomyBoundary("before_write", wroteAlready);
    core.markAttemptedWrite();
    try {
      await writer.append(table, [row]);
    } catch {
      core.poison();
      failTaxonomy("recovery_required");
    }
    await core.taxonomyBoundary(successBoundary, true);
    await core.afterWrite(async () => {
      await writer.refresh(table);
      const id = row.id as string;
      const workspace = row.workspace_name as string;
      const stored = await scopedOne(
        writer,
        table,
        `${scopeOf(workspace)} AND id = ${quote(id)}`,
      );
      if (stored === null) {
        core.poison();
        failTaxonomy("recovery_required");
      }
      const encoded = table === TERMS ? encodeTermRow(stored) : encodeVocabularyRow(stored);
      const fields = table === TERMS ? TERM_FIELDS : VOCABULARY_FIELDS;
      const expected = table === TERMS ? encodeTermRow(row) : encodeVocabularyRow(row);
      for (const field of fields) {
        if (encoded[field] !== expected[field]) {
          core.poison();
          failTaxonomy("recovery_required");
        }
      }
    });
    await core.taxonomyBoundary("after_readback", true);
  };

  /**
   * Resolve the workspace row before ANY identity lookup.
   *
   * Contract precedence is: request validity, workspace, scoped target
   * identity, stored integrity, foreign refs, expected value, persistence.
   * Skipping this let rows be written into a scope with no workspaces row --
   * orphan state that nothing downstream can distinguish from real data.
   */
  const requireWorkspaceRow = async (workspace: string): Promise<void> => {
    await writer.refresh("workspaces");
    const row = await scopedOne(writer, "workspaces", `name = ${quote(workspace)}`);
    if (row === null) failTaxonomy("invalid_reference", "/workspace_name");
  };

  const lookupVocabularyById = (workspace: string, id: string) =>
    scopedOne(writer, VOCABULARIES, `${scopeOf(workspace)} AND id = ${quote(id)}`);
  const lookupVocabularyByName = (workspace: string, name: string) =>
    scopedOne(writer, VOCABULARIES, `${scopeOf(workspace)} AND name = ${quote(name)}`);
  const lookupTermById = (workspace: string, id: string) =>
    scopedOne(writer, TERMS, `${scopeOf(workspace)} AND id = ${quote(id)}`);
  const lookupTermByName = (workspace: string, vocabularyId: string, name: string) =>
    scopedOne(
      writer,
      TERMS,
      `${scopeOf(workspace)} AND vocabulary_id = ${quote(vocabularyId)} AND name = ${quote(name)}`,
    );

  return {
    ...reads,

    createVocabulary: (requestBytes: Uint8Array): Promise<MutationOutcome> =>
      mutate(async () => {
        const request = parseCreateVocabulary(requestBytes);
        // Preflight the WHOLE request before mutating anything.
        await requireWorkspaceRow(request.workspace_name);
        await writer.refresh(VOCABULARIES);
        const byId = await lookupVocabularyById(request.workspace_name, request.vocabulary_id);
        const byName = await lookupVocabularyByName(request.workspace_name, request.name);

        const expected: TaxonomyRow = {
          id: request.vocabulary_id,
          name: request.name,
          workspace_name: request.workspace_name,
          label: request.label,
          description: request.description,
          kind: request.kind,
          term_policy: request.term_policy,
          cardinality: request.cardinality,
          required: request.required,
          hierarchy: request.hierarchy,
          h_metadata: null,
          internal_metadata: null,
          created_at: BigInt(options.clock()) * 1000n,
        };

        if (byId !== null) {
          const stored = encodeVocabularyRow(byId);
          // A row at the requested ID is the EXPECTED row, not a collision
          // merely because it exists. Only a mismatch conflicts.
          if (!sameExcept(stored, encodeVocabularyRow(expected), VOCABULARY_FIELDS)) {
            failTaxonomy("conflict", "/vocabulary_id");
          }
          return { outcome: "already_satisfied" as const, row: stored };
        }
        // A DIFFERENT id already occupying this scoped name conflicts on name.
        if (byName !== null) failTaxonomy("conflict", "/name");

        await writeRow(VOCABULARIES, expected, "after_vocabulary_write", false);
        return { outcome: "created" as const, row: encodeVocabularyRow(expected) };
      }),

    createTerm: (requestBytes: Uint8Array): Promise<MutationOutcome> =>
      mutate(async () => {
        const request = parseCreateTerm(requestBytes);
        await requireWorkspaceRow(request.workspace_name);
        await writer.refresh(VOCABULARIES);
        await writer.refresh(TERMS);

        // Foreign references first: a missing or cross-workspace vocabulary is
        // an invalid reference, not a conflict.
        const vocabulary = await lookupVocabularyById(request.workspace_name, request.vocabulary_id);
        if (vocabulary === null) failTaxonomy("invalid_reference", "/vocabulary_id");
        const vocabularyRow = encodeVocabularyRow(vocabulary);

        if (request.parent_id !== null) {
          if (vocabularyRow.hierarchy !== "tree") failTaxonomy("invalid_request", "/parent_id");
          // The WHOLE ancestry, bounded and scoped -- not just the immediate
          // parent. A parent can be active and in-vocabulary while its own
          // ancestor is missing or cyclic, and attaching beneath it would add
          // a new row to a chain that is already structurally invalid.
          await assertAncestryIsSafe(
            request.workspace_name,
            request.vocabulary_id,
            request.term_id,
            request.parent_id,
          );
        }

        const expected: TaxonomyRow = {
          id: request.term_id,
          workspace_name: request.workspace_name,
          vocabulary_id: request.vocabulary_id,
          name: request.name,
          description: request.description,
          parent_id: request.parent_id,
          weight: 0,
          is_active: true,
          h_metadata: null,
          created_at: BigInt(options.clock()) * 1000n,
        };

        // Uniqueness is validated BEFORE any satisfied return. A matching ID
        // does not excuse a DIFFERENT row holding the same scoped name, and
        // reporting already-satisfied over that would call a corrupt dataset
        // healthy. Name collisions include retired rows: a retired name still
        // occupies its scoped identity.
        const byName = await lookupTermByName(
          request.workspace_name,
          request.vocabulary_id,
          request.name,
        );
        if (byName !== null && byName.id !== request.term_id) failTaxonomy("conflict", "/name");

        const byId = await lookupTermById(request.workspace_name, request.term_id);
        if (byId !== null) {
          const stored = encodeTermRow(byId);
          if (!sameExcept(stored, encodeTermRow(expected), TERM_FIELDS)) {
            failTaxonomy("conflict", "/term_id");
          }
          return { outcome: "already_satisfied" as const, row: stored };
        }

        await writeRow(TERMS, expected, "after_term_write", false);
        return { outcome: "created" as const, row: encodeTermRow(expected) };
      }),

    renameTerm: (requestBytes: Uint8Array): Promise<MutationOutcome> =>
      mutate(async () => {
        const request = parseRenameTerm(requestBytes);
        await requireWorkspaceRow(request.workspace_name);
        await writer.refresh(TERMS);
        const existing = await lookupTermById(request.workspace_name, request.term_id);
        if (existing === null) failTaxonomy("not_found", "/term_id");
        const stored = encodeTermRow(existing);
        if (stored.is_active !== true) failTaxonomy("invalid_request", "/term_id");

        // Uniqueness FIRST, so an already-satisfied rename cannot skip it.
        // Collisions include RETIRED rows: a retired name still occupies its
        // scoped identity and must not be reused.
        const clash = await lookupTermByName(
          request.workspace_name,
          stored.vocabulary_id as string,
          request.name,
        );
        if (clash !== null && clash.id !== request.term_id) failTaxonomy("conflict", "/name");

        // DESIRED first, then expected. Comparing expected first would report a
        // guard mismatch for a request that is already satisfied.
        if (stored.name === request.name) {
          return { outcome: "already_satisfied" as const, row: stored };
        }
        if (stored.name !== request.expected_name) failTaxonomy("conflict", "/expected_name");

        return await updateTerm(
          request.workspace_name,
          request.term_id,
          { name: quote(request.name) },
          `name = ${quote(request.expected_name)}`,
          { ...stored, name: request.name },
        );
      }),

    retireTerm: (requestBytes: Uint8Array): Promise<MutationOutcome> =>
      mutate(async () => {
        const request = parseRetireTerm(requestBytes);
        await requireWorkspaceRow(request.workspace_name);
        await writer.refresh(TERMS);
        await writer.refresh(VOCABULARIES);
        const existing = await lookupTermById(request.workspace_name, request.term_id);
        if (existing === null) failTaxonomy("not_found", "/term_id");
        const stored = encodeTermRow(existing);

        // The vocabulary is resolved BEFORE the satisfied return: an orphaned
        // term must name its problem rather than report already-satisfied and
        // leave the operator believing the state is fine.
        const vocabulary = await lookupVocabularyById(
          request.workspace_name,
          stored.vocabulary_id as string,
        );
        if (vocabulary === null) failTaxonomy("integrity_failure", "");

        // No reactivation exists, so an already-inactive term is satisfied.
        if (stored.is_active !== true) {
          return { outcome: "already_satisfied" as const, row: stored };
        }
        if (encodeVocabularyRow(vocabulary).required === true) {
          // Refuse retiring the LAST active term of a required vocabulary:
          // that would leave a required classification unsatisfiable.
          const active = await writer.query(
            TERMS,
            `${scopeOf(request.workspace_name)} AND vocabulary_id = ${quote(stored.vocabulary_id as string)} AND is_active = true`,
          );
          if (active.length <= 1) failTaxonomy("invalid_request", "/term_id");
        }

        // Children are deliberately NOT reparented or retired: a retired
        // parent may remain in historical tree structure.
        return await updateTerm(
          request.workspace_name,
          request.term_id,
          { is_active: "false" },
          "is_active = true",
          { ...stored, is_active: false },
        );
      }),

    reparentTerm: (requestBytes: Uint8Array): Promise<MutationOutcome> =>
      mutate(async () => {
        const request = parseReparentTerm(requestBytes);
        await requireWorkspaceRow(request.workspace_name);
        await writer.refresh(TERMS);
        await writer.refresh(VOCABULARIES);
        const existing = await lookupTermById(request.workspace_name, request.term_id);
        if (existing === null) failTaxonomy("not_found", "/term_id");
        const stored = encodeTermRow(existing);
        if (stored.is_active !== true) failTaxonomy("invalid_request", "/term_id");

        const vocabulary = await lookupVocabularyById(
          request.workspace_name,
          stored.vocabulary_id as string,
        );
        if (vocabulary === null) failTaxonomy("integrity_failure", "");
        const hierarchy = encodeVocabularyRow(vocabulary).hierarchy;

        if (hierarchy !== "tree") {
          // A flat vocabulary accepts only a null desired parent, and a
          // malformed non-null STORED parent is corruption this operation
          // deliberately refuses to repair.
          if (request.parent_id !== null) failTaxonomy("invalid_request", "/parent_id");
          if (stored.parent_id !== null) failTaxonomy("integrity_failure", "");
        }

        if (request.parent_id !== null) {
          if (request.parent_id === request.term_id) failTaxonomy("invalid_request", "/parent_id");
          // Validate the requested structure BEFORE any already-satisfied
          // shortcut: "desired equals current" must not skip cycle detection.
          await assertAncestryIsSafe(
            request.workspace_name,
            stored.vocabulary_id as string,
            request.term_id,
            request.parent_id,
          );
        }

        if (stored.parent_id === request.parent_id) {
          return { outcome: "already_satisfied" as const, row: stored };
        }
        if (stored.parent_id !== request.expected_parent_id) {
          failTaxonomy("conflict", "/expected_parent_id");
        }

        const guard =
          request.expected_parent_id === null
            ? "parent_id IS NULL"
            : `parent_id = ${quote(request.expected_parent_id)}`;
        return await updateTerm(
          request.workspace_name,
          request.term_id,
          { parent_id: request.parent_id === null ? "NULL" : quote(request.parent_id) },
          guard,
          { ...stored, parent_id: request.parent_id },
        );
      }),

    seedReservedVocabularies: (requestBytes: Uint8Array) =>
      mutate(async () => seedReserved(requestBytes)),
  };

  /**
   * Walk the DESIRED parent's ancestry to null, detecting self-reference and
   * cycles with scoped unique lookups.
   *
   * Bounded at 1024 visited rows, equality accepted, cumulative: row 1025
   * fails limit_exceeded rather than walking a corrupt chain forever.
   */
  async function assertAncestryIsSafe(
    workspace: string,
    vocabularyId: string,
    termId: string,
    desiredParentId: string,
  ): Promise<void> {
    const parent = await lookupTermById(workspace, desiredParentId);
    if (parent === null) failTaxonomy("invalid_reference", "/parent_id");
    const parentRow = encodeTermRow(parent);
    if (parentRow.is_active !== true) failTaxonomy("invalid_request", "/parent_id");
    if (parentRow.vocabulary_id !== vocabularyId) failTaxonomy("invalid_reference", "/parent_id");

    let cursor: string | null = desiredParentId;
    let visited = 0;
    const seen = new Set<string>();
    while (cursor !== null) {
      visited += 1;
      if (visited > 1024) failTaxonomy("limit_exceeded", "");
      // Reaching the term being moved means the requested parent sits BELOW
      // it: that is the cycle.
      if (cursor === termId) failTaxonomy("invalid_request", "/parent_id");
      if (seen.has(cursor)) failTaxonomy("integrity_failure", "");
      seen.add(cursor);
      const row: Record<string, unknown> | null = await lookupTermById(workspace, cursor);
      if (row === null) failTaxonomy("integrity_failure", "");
      const encoded = encodeTermRow(row);
      if (encoded.vocabulary_id !== vocabularyId) failTaxonomy("integrity_failure", "");
      cursor = (encoded.parent_id as string | null) ?? null;
    }
  }

  /**
   * Bootstrap the two reserved vocabularies and their seven terms.
   *
   * RESUMABLE by design. Any subset of the nine rows may already exist,
   * including terms whose vocabulary is still absent and a vocabulary whose
   * terms are not all there. Neither state is corruption and neither is
   * completion, so each present row is compared to literal seed state and each
   * absent row is staged.
   *
   * A row that has been renamed, retired or otherwise changed CONFLICTS. It is
   * not repaired: reconciliation is outside this slice and needs a later
   * reviewed operator operation. Re-running seed never claims to fix
   * administration, and a missing or altered `note` never silently generates a
   * substitute default.
   */
  async function seedReserved(requestBytes: Uint8Array) {
    const request = parseSeedRequest(requestBytes);
    const workspace = request.workspace_name;
    await requireWorkspaceRow(workspace);
    await writer.refresh(VOCABULARIES);
    await writer.refresh(TERMS);

    const now = options.clock();
    const wantVocabularies = seedVocabularyRows(request, now);
    const wantTerms = seedTermRows(request, now);

    // ---- Preflight the ENTIRE manifest before mutating anything.
    const resolved: Array<{
      table: string;
      want: TaxonomyRow;
      stored: TaxonomyRow | null;
      pointer: string;
    }> = [];

    // Each row's EXACT manifest pointer. Reporting a horizon collision at
    // /type/terms sends a caller to the wrong field entirely.
    const termPointer = (name: string): string =>
      (SEED_TERM_ORDER.indexOf(name as never) < 5 ? "/type/terms/" : "/memory_horizon/terms/") + name;

    for (const want of wantTerms) {
      const pointer = termPointer(want.name as string);
      const stored = await lookupTermById(workspace, want.id as string);
      // Uniqueness is checked REGARDLESS of whether the ID already matches.
      // A matching ID does not excuse a different row holding the same scoped
      // name: the contract asks for full validation even on the satisfied
      // path, and returning already-satisfied over a duplicate would report a
      // corrupt dataset as healthy.
      const byName = await lookupTermByName(
        workspace,
        want.vocabulary_id as string,
        want.name as string,
      );
      if (byName !== null && byName.id !== want.id) failTaxonomy("conflict", pointer);

      if (stored !== null) {
        const encoded = encodeTermRow(stored);
        // A staged term whose vocabulary_id differs from the supplied manifest
        // CONFLICTS. It is never transferred or adopted into this manifest.
        if (!sameExcept(encoded, encodeTermRow(want), TERM_FIELDS)) {
          failTaxonomy("conflict", pointer);
        }
        resolved.push({ table: TERMS, want, stored: encoded, pointer });
        continue;
      }
      resolved.push({ table: TERMS, want, stored: null, pointer });
    }

    for (const want of wantVocabularies) {
      const pointer = `/${want.name as string}/vocabulary_id`;
      const stored = await lookupVocabularyById(workspace, want.id as string);
      const byName = await lookupVocabularyByName(workspace, want.name as string);
      if (byName !== null && byName.id !== want.id) failTaxonomy("conflict", pointer);

      if (stored !== null) {
        const encoded = encodeVocabularyRow(stored);
        if (!sameExcept(encoded, encodeVocabularyRow(want), VOCABULARY_FIELDS)) {
          failTaxonomy("conflict", pointer);
        }
        resolved.push({ table: VOCABULARIES, want, stored: encoded, pointer });
        continue;
      }
      resolved.push({ table: VOCABULARIES, want, stored: null, pointer });
    }

    // ---- Stage ONLY what is missing, in literal manifest order: the seven
    // terms first, then the two vocabularies. Matching rows are skipped
    // without rewriting them or resampling their clocks, and emit NO
    // mutation boundaries at all.
    let wroteAny = false;
    for (const entry of resolved) {
      if (entry.stored !== null) continue;
      const success: TaxonomyBoundary =
        entry.table === TERMS ? "after_term_write" : "after_vocabulary_write";
      await writeRow(entry.table, entry.want, success, wroteAny);
      wroteAny = true;
    }

    // ---- Final all-row verification. Mandatory, covered by the operation-wide
    // post-write guard, and deliberately emitting no after_readback of its own
    // so the trace stays one triple per mutated row.
    const verify = async () => {
      await writer.refresh(VOCABULARIES);
      await writer.refresh(TERMS);
      const terms: TaxonomyRow[] = [];
      const vocabularies: TaxonomyRow[] = [];
      // Expected state per row: an existing row keeps its own retained
      // created_at, a newly staged one carries the allocation time we wrote.
      const expectedFor = (entry: (typeof resolved)[number], encode: (r: TaxonomyRow) => TaxonomyRow) =>
        entry.stored ?? encode(entry.want);

      for (const entry of resolved) {
        const isTerm = entry.table === TERMS;
        const stored = isTerm
          ? await lookupTermById(workspace, entry.want.id as string)
          : await lookupVocabularyById(workspace, entry.want.id as string);
        if (stored === null) failTaxonomy("recovery_required");
        const encoded = isTerm ? encodeTermRow(stored) : encodeVocabularyRow(stored);
        const expected = expectedFor(entry, isTerm ? encodeTermRow : encodeVocabularyRow);
        // Re-CHECK equality. Decoding alone would accept a row that was
        // corrupted after it was written and verified.
        for (const field of isTerm ? TERM_FIELDS : VOCABULARY_FIELDS) {
          if (encoded[field] !== expected[field]) failTaxonomy("recovery_required");
        }
        (isTerm ? terms : vocabularies).push(encoded);
      }
      return { vocabularies, terms };
    };
    const rows = wroteAny ? await core.afterWrite(verify) : await verify();

    return {
      // `created` means THIS call appended at least one row. A resumed seed can
      // therefore return created without having created every row it returns.
      outcome: wroteAny ? ("created" as const) : ("already_satisfied" as const),
      vocabularies: rows.vocabularies,
      terms: rows.terms,
    };
  }

  /** Guarded single-row update: exactly one affected row, then full readback. */
  async function updateTerm(
    workspace: string,
    termId: string,
    assignments: Record<string, string>,
    guard: string,
    /** The complete row this update must produce, field for field. */
    expected: TaxonomyRow,
  ): Promise<MutationOutcome> {
    await core.taxonomyBoundary("before_write", false);
    core.markAttemptedWrite();
    const { rowsUpdated } = await core.afterWrite(async () =>
      writer.updateWhere(
        TERMS,
        `${scopeOf(workspace)} AND id = ${quote(termId)} AND ${guard}`,
        assignments,
      ),
    );
    // Anything but exactly one row is ambiguous: fail-stop, never guess.
    if (rowsUpdated !== 1) {
      core.poison();
      failTaxonomy("recovery_required");
    }
    await core.taxonomyBoundary("after_update", true);
    const row = await core.afterWrite(async () => {
      await writer.refresh(TERMS);
      const stored = await lookupTermById(workspace, termId);
      if (stored === null) {
        core.poison();
        failTaxonomy("recovery_required");
      }
      const encoded = encodeTermRow(stored);
      // COMPARE, do not merely decode. Encoding proves the row is structurally
      // valid; it says nothing about whether it holds what we asked for. A
      // non-throwing hook that corrupts a field between the update and this
      // read would otherwise be accepted and returned as the result.
      for (const field of TERM_FIELDS) {
        if (encoded[field] !== expected[field]) {
          core.poison();
          failTaxonomy("recovery_required");
        }
      }
      return encoded;
    });
    await core.taxonomyBoundary("after_readback", true);
    return { outcome: "updated" as const, row };
  }
}

export type TaxonomyReaderService = ReturnType<typeof createTaxonomyReadMethods>;
export type TaxonomyWriterService = ReturnType<typeof createTaxonomyWriterService>;

export type KnowledgeReaderService = {
  publication: PublicationReaderService;
  taxonomy: TaxonomyReaderService;
};

export type KnowledgeWriterService = {
  publication: Omit<PublicationWriterService, "close">;
  taxonomy: TaxonomyWriterService;
  close: () => Promise<void>;
};

export type KnowledgeOptions = OperatorOptions & { onTaxonomyBoundary?: TaxonomyBoundaryHook };

/**
 * Read both facades over one gateless connection.
 *
 * Reads need no gate and no queue, so this contends with nothing: a poisoned
 * or released writer elsewhere does not make a fresh reader unusable.
 */
export async function openKnowledgeReader(datasetRoot: string): Promise<KnowledgeReaderService> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  const adapter = makeAdapter(await openPrivateConnection(canonical), () => {});
  return Object.freeze({
    publication: Object.freeze(makeReadMethods(adapter)),
    taxonomy: Object.freeze(createTaxonomyReadMethods(adapter)),
  });
}

/**
 * One owner, two write facades.
 *
 * The bundle ALONE closes the owner: `publication` here carries its three data
 * methods without `close`, and `taxonomy` has no `close` at all, so neither
 * facade can release a gate the other still depends on.
 *
 * Because the bundle offers publication, it requires the existing
 * `newRevisionId` dependency even when a caller only touches taxonomy --
 * taxonomy never calls it, and allocating one lazily would hide a missing
 * dependency until the first publish.
 */
export async function openKnowledgeWriter(
  datasetRoot: string,
  options: KnowledgeOptions,
): Promise<KnowledgeWriterService> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  // Gate and single-owner claim BOTH precede connect, exactly as the
  // publication writer does: cross-factory opens on the same root contend.
  assertInheritedGate(canonical, options.env);
  if (OWNERS.has(canonical)) failPublication("writer_unavailable");
  const token = Symbol(canonical);
  OWNERS.set(canonical, token);

  let adapter: DatasetAdapter;
  try {
    adapter = makeAdapter(await openPrivateConnection(canonical), () => {
      if (OWNERS.get(canonical) === token) OWNERS.delete(canonical);
    });
  } catch (error) {
    OWNERS.delete(canonical);
    throw error;
  }

  const clock = options.clock ?? Date.now;
  const core = createOwnerCore(adapter, {
    onBoundary: options.onBoundary,
    onTaxonomyBoundary: options.onTaxonomyBoundary,
  });
  const publication = createPublicationWriterService(
    adapter,
    { clock, newRevisionId: options.newRevisionId },
    core,
  );
  const taxonomy = createTaxonomyWriterService(adapter, core, { clock });

  const { close: _ownedByTheBundle, ...publicationData } = publication;
  return Object.freeze({
    publication: Object.freeze(publicationData),
    taxonomy: Object.freeze(taxonomy),
    close: core.close,
  });
}

/* ------------------------------------------------------------------ *
 * Context registration and ordered ingestion. Private to this module.
 * ------------------------------------------------------------------ */

const WORKSPACES = "workspaces";
const PEERS = "peers";
const SESSIONS = "sessions";
const SESSION_PEERS = "session_peers";
const MESSAGES = "messages";

const INT64_CEILING = 2n ** 63n - 1n;

/** Exactly one row at a scoped identity, or null. Never a first-match guess. */
async function contextOne(
  adapter: DatasetAdapter,
  table: string,
  predicate: string,
): Promise<Record<string, unknown> | null> {
  const rows = await adapter.query(table, predicate, 2);
  if (rows.length === 0) return null;
  // Two rows at an identity that must be unique is corruption. Picking one
  // would make a corrupt dataset look healthy. ROOT path: a global stored-state
  // failure is not a complaint about a caller field.
  if (rows.length > 1) failPublication("integrity_failure", "");
  return rows[0]!;
}

/**
 * The greatest stored value of an Int64 key, or null when the scope is empty.
 *
 * Ordered projection, never `limit` alone: an unordered limit returns an
 * ARBITRARY row and can never yield a maximum. The selected extremum is
 * validated and then required unique on its own key, because an extremum read
 * says nothing about duplicates elsewhere -- this is deliberately NOT a
 * whole-corpus integrity audit.
 */
async function selectedMaximum(
  adapter: DatasetAdapter,
  table: string,
  column: string,
  predicate: string,
): Promise<bigint | null> {
  const top = await adapter.orderedProjection(
    table,
    predicate,
    [column],
    { column, ascending: false },
    1,
  );
  if (top.length === 0) return null;
  const raw = top[0]![column];
  if (typeof raw !== "bigint") failPublication("integrity_failure", "");
  const value = raw;
  if (value < -(2n ** 63n) || value > INT64_CEILING) failPublication("integrity_failure", "");
  // Equality query bounded at 2 rows: enough to discriminate a duplicate key
  // without pretending to have audited the rest of the table.
  const sameKey = await adapter.query(table, `${predicate} AND ${column} = ${value.toString(10)}`, 2);
  if (sameKey.length !== 1) failPublication("integrity_failure", "");
  return value;
}

function contextScope(workspace: string): string {
  return `workspace_name = ${quote(workspace)}`;
}

function createContextReadMethods(reader: DatasetAdapter) {
  /** Reads present the publication envelope, like every other owner failure. */
  const requireWorkspace = async (workspace: string): Promise<void> => {
    await reader.refresh(WORKSPACES);
    const row = await contextOne(reader, WORKSPACES, `name = ${quote(workspace)}`);
    if (row === null) failPublication("invalid_reference", "/workspace_name");
  };

  return {
    async getPeer(requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
      const request = parseGetPeer(requestBytes);
      await requireWorkspace(request.workspace_name);
      await reader.refresh(PEERS);
      const row = await contextOne(
        reader,
        PEERS,
        `${contextScope(request.workspace_name)} AND name = ${quote(request.peer_name)}`,
      );
      // Absent is null, NOT not_found: that code's fixed message is node-specific.
      return row === null ? null : encodePeerRow(row);
    },

    async getSession(requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
      const request = parseGetSession(requestBytes);
      await requireWorkspace(request.workspace_name);
      await reader.refresh(SESSIONS);
      const row = await contextOne(
        reader,
        SESSIONS,
        `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
      );
      // Retired status does not erase readable history, so inactive is returned.
      return row === null ? null : encodeSessionRow(row);
    },

    async getMessage(requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
      const request = parseGetMessage(requestBytes);
      await requireWorkspace(request.workspace_name);
      await reader.refresh(MESSAGES);
      const row = await contextOne(
        reader,
        MESSAGES,
        `${contextScope(request.workspace_name)} AND public_id = ${quote(request.public_id)}`,
      );
      if (row === null) return null;
      const encoded = encodeMessageRow(row);
      // A single row over the response budget is refused rather than truncated.
      if (rowWireBytes(encoded) > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
      return encoded;
    },

    async listMessages(
      requestBytes: Uint8Array,
    ): Promise<{ rows: Record<string, unknown>[]; next_after_seq: string | null }> {
      const request = parseListMessages(requestBytes);
      await requireWorkspace(request.workspace_name);
      await reader.refresh(SESSIONS);
      const session = await contextOne(
        reader,
        SESSIONS,
        `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
      );
      if (session === null) failPublication("invalid_reference", "/session_name");

      await reader.refresh(MESSAGES);
      const after = request.after_seq === null ? null : BigInt(request.after_seq);
      const scope =
        `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)}` +
        (after === null ? "" : ` AND seq_in_session > ${after.toString(10)}`);

      // KEYSET, never offset: limit+1 detects continuation without paging by
      // position, which would skip or repeat rows as the table grows.
      const selected = await reader.orderedProjection(
        MESSAGES,
        scope,
        ["seq_in_session", "public_id"],
        { column: "seq_in_session", ascending: true },
        request.limit + 1,
      );

      const keys: bigint[] = [];
      const publicIds = new Set<string>();
      for (const row of selected) {
        const seq = row.seq_in_session;
        if (typeof seq !== "bigint") failPublication("integrity_failure", "");
        // The LOOKAHEAD row is validated too, not just the emitted page: a
        // duplicate straddling the limit would otherwise evade the check and
        // split silently across two pages.
        if (keys.some((k) => k === seq)) failPublication("integrity_failure", "");
        keys.push(seq);
        const publicId = row.public_id;
        if (typeof publicId !== "string") failPublication("integrity_failure", "");
        if (publicIds.has(publicId)) failPublication("integrity_failure", "");
        publicIds.add(publicId);
      }

      const page = keys.slice(0, request.limit);
      const rows: Record<string, unknown>[] = [];
      // Brackets plus one comma per row: sum + n + 1.
      let budget = 1;
      for (const seq of page) {
        const row = await contextOne(
          reader,
          MESSAGES,
          `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)} AND seq_in_session = ${seq.toString(10)}`,
        );
        if (row === null) failPublication("integrity_failure", "");
        const encoded = encodeMessageRow(row);
        budget += rowWireBytes(encoded) + 1;
        // Cumulative wire budget. Over budget fails; it never truncates, which
        // would hand back a short page indistinguishable from a real one.
        if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
        rows.push(encoded);
      }

      const hasMore = keys.length > request.limit;
      return {
        rows,
        next_after_seq: hasMore && page.length > 0 ? page[page.length - 1]!.toString(10) : null,
      };
    },
  };
}

export type ContextBoundary = "before_write" | "after_write" | "after_readback";
export type ContextBoundaryHook = (boundary: ContextBoundary) => Promise<void>;

type ContextRegistration =
  | { outcome: "created" | "already_satisfied"; row: Record<string, unknown> }
  | { outcome: "conflict"; reason: "id" | "name" | "membership" };

function createContextWriterService(
  writer: DatasetAdapter,
  core: OwnerCore,
  options: { clock: Clock; sourceNamespace: string | null },
) {
  const reads = createContextReadMethods(writer);

  /** Mutations run on the SHARED queue, so a context failure poisons the
   *  publication and taxonomy facades too, and vice versa. */
  const mutate = <T>(work: () => Promise<T>): Promise<T> => core.serial(work);

  const requireWorkspaceRow = async (workspace: string): Promise<void> => {
    await writer.refresh(WORKSPACES);
    const row = await contextOne(writer, WORKSPACES, `name = ${quote(workspace)}`);
    if (row === null) failPublication("invalid_reference", "/workspace_name");
  };

  /**
   * Persist one row and prove it landed.
   *
   * Boundary order is frozen per appended row: before_write immediately before
   * the SDK call, after_write on success, then readback verification, then
   * after_readback. The attempted flag is set immediately before the SDK call
   * and NOT before the hook, so a first hook failure with nothing attempted
   * leaves the owner usable while a later one poisons.
   */
  const writeRow = async (
    table: string,
    row: Record<string, unknown>,
    verify: () => Promise<Record<string, unknown>>,
    expected: Record<string, unknown>,
    fields: readonly string[],
    wroteAlready: boolean,
  ): Promise<Record<string, unknown>> => {
    await core.contextBoundary("before_write", wroteAlready);
    core.markAttemptedWrite();
    try {
      await writer.append(table, [row]);
    } catch {
      core.poison();
      failPublication("recovery_required", "");
    }
    await core.contextBoundary("after_write", true);
    const stored = await core.afterWrite(async () => {
      await writer.refresh(table);
      const found = await verify();
      // COMPARE every physical field. Decoding proves structural validity and
      // says nothing about whether the row holds what was asked for.
      for (const field of fields) {
        if (found[field] !== expected[field]) {
          core.poison();
          failPublication("recovery_required", "");
        }
      }
      return found;
    });
    await core.contextBoundary("after_readback", true);
    return stored;
  };

  const registerNamed = async (
    table: string,
    workspace: string,
    requestedId: string,
    requestedName: string,
    build: (createdAt: bigint) => Record<string, unknown>,
    encode: (row: Record<string, unknown>) => Record<string, unknown>,
    fields: readonly string[],
  ): Promise<ContextRegistration> => {
    await requireWorkspaceRow(workspace);
    await writer.refresh(table);
    const byId = await contextOne(writer, table, `${contextScope(workspace)} AND id = ${quote(requestedId)}`);
    const byName = await contextOne(writer, table, `${contextScope(workspace)} AND name = ${quote(requestedName)}`);

    if (byId !== null) {
      const stored = encode(byId);
      // ID disagreement takes precedence after integrity checks.
      if (stored.name !== requestedName) return { outcome: "conflict", reason: "id" };
      // Same scoped ID+name: already satisfied, retaining the ORIGINAL
      // timestamp and every current optional field. Nothing is rewritten.
      return { outcome: "already_satisfied", row: stored };
    }
    if (byName !== null) return { outcome: "conflict", reason: "name" };

    const createdAt = BigInt(options.clock()) * 1000n;
    const physical = build(createdAt);
    const expected = encode(physical);
    const stored = await writeRow(
      table,
      physical,
      async () => {
        const found = await contextOne(writer, table, `${contextScope(workspace)} AND id = ${quote(requestedId)}`);
        if (found === null) {
          core.poison();
          failPublication("recovery_required", "");
        }
        return encode(found);
      },
      expected,
      fields,
      false,
    );
    return { outcome: "created", row: stored };
  };

  return {
    ...reads,

    registerPeer: (requestBytes: Uint8Array): Promise<ContextRegistration> =>
      mutate(async () => {
        const request = parseRegisterPeer(requestBytes);
        return registerNamed(
          PEERS,
          request.workspace_name,
          request.peer_id,
          request.name,
          (created_at) => ({
            id: request.peer_id,
            name: request.name,
            workspace_name: request.workspace_name,
            // New optional fields are null. Peers are NEVER merged by display
            // metadata or label resemblance.
            h_metadata: null,
            internal_metadata: null,
            configuration: null,
            created_at,
          }),
          encodePeerRow,
          PEER_FIELDS_LOCAL,
        );
      }),

    registerSession: (requestBytes: Uint8Array): Promise<ContextRegistration> =>
      mutate(async () => {
        const request = parseRegisterSession(requestBytes);
        return registerNamed(
          SESSIONS,
          request.workspace_name,
          request.session_id,
          request.name,
          (created_at) => ({
            id: request.session_id,
            name: request.name,
            workspace_name: request.workspace_name,
            is_active: true,
            h_metadata: null,
            internal_metadata: null,
            configuration: null,
            created_at,
          }),
          encodeSessionRow,
          SESSION_FIELDS_LOCAL,
        );
      }),

    joinSession: (requestBytes: Uint8Array): Promise<ContextRegistration> =>
      mutate(async () => {
        const request = parseJoinSession(requestBytes);
        await requireWorkspaceRow(request.workspace_name);
        await writer.refresh(SESSIONS);
        await writer.refresh(PEERS);

        const session = await contextOne(
          writer,
          SESSIONS,
          `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
        );
        if (session === null) failPublication("invalid_reference", "/session_name");
        if (encodeSessionRow(session).is_active !== true) {
          failPublication("invalid_reference", "/session_name");
        }
        const peer = await contextOne(
          writer,
          PEERS,
          `${contextScope(request.workspace_name)} AND name = ${quote(request.peer_name)}`,
        );
        if (peer === null) failPublication("invalid_reference", "/peer_name");

        await writer.refresh(SESSION_PEERS);
        const triple =
          `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)}` +
          ` AND peer_name = ${quote(request.peer_name)}`;
        const existing = await contextOne(writer, SESSION_PEERS, triple);
        if (existing !== null) {
          const stored = encodeSessionPeerRow(existing);
          // A left membership is TERMINAL through this interface. Rejoin is a
          // separately reviewed lifecycle operation; rewriting left_at here
          // would erase history.
          if (stored.left_at !== null) return { outcome: "conflict", reason: "membership" };
          return { outcome: "already_satisfied", row: stored };
        }

        const joined = BigInt(options.clock()) * 1000n;
        const physical = {
          workspace_name: request.workspace_name,
          session_name: request.session_name,
          peer_name: request.peer_name,
          configuration: null,
          internal_metadata: null,
          joined_at: joined,
          left_at: null,
        };
        const stored = await writeRow(
          SESSION_PEERS,
          physical,
          async () => {
            const found = await contextOne(writer, SESSION_PEERS, triple);
            if (found === null) {
              core.poison();
              failPublication("recovery_required", "");
            }
            return encodeSessionPeerRow(found);
          },
          encodeSessionPeerRow(physical),
          SESSION_PEER_FIELDS_LOCAL,
          false,
        );
        return { outcome: "created", row: stored };
      }),

    /**
     * Ordered batch ingestion.
     *
     * Whole-request grammar is validated BEFORE queue admission, so a malformed
     * request throws rather than producing a fake index-0 result. Once admitted
     * the shared queue is held for the entire call.
     *
     * Safe and unknown exceptions propagate through the shared serial boundary
     * FIRST -- catching them inside would bypass operation-wide poisoning --
     * and only the outside handler turns them into a durable-prefix result. A
     * known conflict returns normally from inside, because it is not an
     * ambiguous write and must not poison.
     */
    appendMessages: async (requestBytes: Uint8Array) => {
      const request = parseAppendMessages(requestBytes);
      const accepted: Array<{ index: number; outcome: "accepted" | "idempotent"; row: Record<string, unknown> }> = [];
      // Brackets, then one comma per row: sum + n + 1, not sum + n.
      let budget = 1;
      // Did the batch actually ENTER the queued turn? A refusal that happens
      // before admission -- closing, poisoned, owner unavailable -- must throw,
      // because no item was ever entered and there is no prefix to report.
      let admitted = false;

      try {
        const conflict = await core.serial(async () => {
          admitted = true;
          await requireWorkspaceRow(request.workspace_name);
          await writer.refresh(SESSIONS);
          const session = await contextOne(
            writer,
            SESSIONS,
            `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
          );
          if (session === null) failPublication("invalid_reference", "/session_name");
          if (encodeSessionRow(session).is_active !== true) {
            failPublication("invalid_reference", "/session_name");
          }

          // Maxima are read ONCE, when the first NEW item needs them, then
          // incremented privately under the held queue. Replays consume none.
          let nextId: bigint | null = null;
          let nextSeq: bigint | null = null;
          let wroteAny = false;

          for (const [index, item] of request.items.entries()) {
            const at = (...rest: string[]) => `/items/${index}${rest.map((r) => `/${r}`).join("")}`;

            await writer.refresh(MESSAGES);
            const byPublicId = await contextOne(
              writer,
              MESSAGES,
              `${contextScope(request.workspace_name)} AND public_id = ${quote(item.public_id)}`,
            );

            // ---- validate mode/digest WITHOUT sampling the clock. A sentinel
            // intake is used because the seven-field digest excludes intake,
            // so both passes agree. Its derived times are discarded.
            let validated: Record<string, unknown>;
            try {
              validated = prepareNewMessage(JSON.stringify({
                context: {
                  workspace_name: request.workspace_name,
                  session_name: request.session_name,
                  intake_at: "1970-01-01T00:00:00.000Z",
                  source_namespace: options.sourceNamespace,
                },
                message: item.message,
                source: item.source,
              }));
            } catch (error) {
              if (isContractError(error)) throw error;
              return failPublication("invalid_request", at());
            }

            const sourceMessageId = validated.source_message_id as string | null;
            const digest = validated.source_payload_digest as string | null;

            // ---- REPLAY resolution. Sourced is anchored to its source tuple.
            let existing: Record<string, unknown> | null = null;
            if (sourceMessageId !== null && options.sourceNamespace !== null) {
              existing = await contextOne(
                writer,
                MESSAGES,
                `${contextScope(request.workspace_name)} AND source_namespace = ${quote(options.sourceNamespace)}` +
                  ` AND source_message_id = ${quote(sourceMessageId)}`,
              );
              if (existing !== null) {
                const stored = encodeMessageRow(existing);
                await requireCurrentMembership(
                  writer,
                  request.workspace_name,
                  request.session_name,
                  stored.peer_name as string,
                  at("message", "peer_name"),
                );
                // Destination FIRST, then proposed-ID collision, THEN payload.
                // The accepted wrapper owns that ordering and the exact error.
                assertReplayDestination(
                  request.workspace_name,
                  request.session_name,
                  stored,
                  `/items/${index}`,
                );
                // A different UNOCCUPIED proposal is ignored and the original
                // id is returned; a proposal naming ANOTHER row conflicts.
                if (byPublicId !== null && byPublicId.public_id !== stored.public_id) {
                  return { index, conflict: "public_id" as const };
                }
                if (stored.source_payload_digest !== digest) {
                  return { index, conflict: "source_payload" as const };
                }
                budget += rowWireBytes(stored) + 1;
                // A response over budget is a LIMIT, not a conflict: reporting
                // public_id here would blame the caller's identifier for a size
                // problem. It stops at this index without a new write.
                if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
                accepted.push({ index, outcome: "idempotent", row: stored });
                continue;
              }
            }

            // Source ABSENT but the proposed id is occupied: that row cannot be
            // adopted into a sourced identity, so it conflicts before any local
            // field comparison runs.
            if (sourceMessageId !== null && existing === null && byPublicId !== null) {
              return { index, conflict: "public_id" as const };
            }

            if (byPublicId !== null) {
              const stored = encodeMessageRow(byPublicId);
              await requireCurrentMembership(
                writer,
                request.workspace_name,
                request.session_name,
                stored.peer_name as string,
                at("message", "peer_name"),
              );
              // Local wrong-destination has the SAME semantics as sourced, so
              // it goes through the same wrapper and carries the same envelope.
              assertReplayDestination(
                request.workspace_name,
                request.session_name,
                stored,
                `/items/${index}`,
              );
              // A local request cannot adopt a sourced row, nor the reverse.
              const storedIsSourced = stored.source_message_id !== null;
              const requestIsSourced = sourceMessageId !== null;
              if (storedIsSourced !== requestIsSourced) return { index, conflict: "public_id" as const };
              if (
                stored.peer_name !== validated.peer_name ||
                stored.content !== validated.content ||
                stored.role !== validated.role ||
                stored.in_reply_to !== validated.in_reply_to
              ) {
                return { index, conflict: "public_id" as const };
              }
              budget += rowWireBytes(stored) + 1;
              if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
              accepted.push({ index, outcome: "idempotent", row: stored });
              continue;
            }

            // ---- Refs and policy. These run for REPLAY as well as for a new
            // item: a replay after the peer left must be refused, and stored
            // identity integrity is not excused by "we saw this before".
            await requireCurrentMembership(
              writer,
              request.workspace_name,
              request.session_name,
              validated.peer_name as string,
              at("message", "peer_name"),
            );

            const replyTo = validated.in_reply_to as string | null;
            if (replyTo !== null) {
              if (replyTo === item.public_id) failPublication("invalid_request", at("message", "in_reply_to"));
              const parent = await contextOne(
                writer,
                MESSAGES,
                `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)}` +
                  ` AND public_id = ${quote(replyTo)}`,
              );
              if (parent === null) failPublication("invalid_reference", at("message", "in_reply_to"));
              await assertReplyChain(writer, request.workspace_name, request.session_name, parent);
            }

            if (nextId === null) {
              const maxId = await selectedMaximum(writer, MESSAGES, "id", "true");
              nextId = (maxId === null || maxId < 0n ? 0n : maxId) + 1n;
              const maxSeq = await selectedMaximum(
                writer,
                MESSAGES,
                "seq_in_session",
                `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)}`,
              );
              nextSeq = (maxSeq === null || maxSeq < 0n ? 0n : maxSeq) + 1n;
            }
            if (nextId! > INT64_CEILING || nextSeq! > INT64_CEILING) {
              failPublication("integrity_failure", "");
            }

            // BOTH proposed keys must be vacant before the append. Checking
            // only the global id would let a session sequence collide.
            const idTaken = await writer.query(MESSAGES, `id = ${nextId!.toString(10)}`, 2);
            if (idTaken.length !== 0) failPublication("integrity_failure", "");
            const seqTaken = await writer.query(
              MESSAGES,
              `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)}` +
                ` AND seq_in_session = ${nextSeq!.toString(10)}`,
              2,
            );
            if (seqTaken.length !== 0) failPublication("integrity_failure", "");

            const intake = new Date(options.clock()).toISOString();
            let row: Record<string, unknown>;
            try {
              row = prepareNewMessage(JSON.stringify({
                context: {
                  workspace_name: request.workspace_name,
                  session_name: request.session_name,
                  intake_at: intake,
                  source_namespace: options.sourceNamespace,
                },
                message: item.message,
                source: item.source,
              }));
            } catch (error) {
              if (isContractError(error)) throw error;
              return failPublication("invalid_request", at());
            }

            const physical = {
              id: nextId!,
              public_id: item.public_id,
              workspace_name: request.workspace_name,
              session_name: request.session_name,
              peer_name: row.peer_name,
              content: row.content,
              // 0 means NOT MEASURED, not a tokenizer result.
              token_count: 0n,
              seq_in_session: nextSeq!,
              h_metadata: null,
              internal_metadata: null,
              created_at: timestampToMicros(row.created_at),
              role: row.role,
              in_reply_to: row.in_reply_to,
              read: null,
              read_at: null,
              source_namespace: row.source_namespace,
              source_message_id: row.source_message_id,
              source_payload_digest: row.source_payload_digest,
              source_created_at:
                row.source_created_at === null ? null : timestampToMicros(row.source_created_at as string),
              ingested_at: timestampToMicros(row.ingested_at),
            };
            const expected = encodeMessageRow(physical);

            const stored = await writeRow(
              MESSAGES,
              physical,
              async () => {
                // FOUR independent identities must each select exactly one row,
                // and it must be the SAME row. A public-id lookup alone would
                // miss a duplicated physical id or a colliding sequence.
                const scope = contextScope(request.workspace_name);
                const lookups: string[] = [
                  `${scope} AND public_id = ${quote(item.public_id)}`,
                  `${scope} AND session_name = ${quote(request.session_name)} AND seq_in_session = ${nextSeq!.toString(10)}`,
                  `id = ${nextId!.toString(10)}`,
                ];
                if (row.source_message_id !== null && row.source_namespace !== null) {
                  lookups.push(
                    `${scope} AND source_namespace = ${quote(row.source_namespace as string)}` +
                      ` AND source_message_id = ${quote(row.source_message_id as string)}`,
                  );
                }
                let selected: Record<string, unknown> | null = null;
                for (const predicate of lookups) {
                  const found = await contextOne(writer, MESSAGES, predicate);
                  if (found === null) {
                    core.poison();
                    failPublication("recovery_required", "");
                  }
                  const encoded = encodeMessageRow(found);
                  if (selected !== null && encoded.public_id !== selected.public_id) {
                    core.poison();
                    failPublication("recovery_required", "");
                  }
                  selected = encoded;
                }
                return selected!;
              },
              expected,
              MESSAGE_FIELDS_LOCAL,
              wroteAny,
            );
            wroteAny = true;
            nextId! += 1n;
            nextSeq! += 1n;
            budget += rowWireBytes(stored) + 1;
            if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
            accepted.push({ index, outcome: "accepted", row: stored });
          }
          return null;
        });

        if (conflict !== null) {
          return { outcome: "stopped" as const, results: accepted, stop: conflict };
        }
        return { outcome: "complete" as const, results: accepted, stop: null };
      } catch (error) {
        // Pre-admission refusal: rethrow. Converting it to a stopped result
        // would invent an item-level failure for a request that never entered.
        if (!admitted) throw error;
        // The serial boundary has ALREADY classified and poisoned as needed.
        // This only serializes the outcome.
        return {
          outcome: "stopped" as const,
          results: accepted,
          stop: { index: accepted.length, error: safeErrorEnvelope(error) },
        };
      }
    },
  };
}

/**
 * Re-anchor a governed error beneath this request's item pointer.
 *
 * Code and MESSAGE are carried across untouched; only the path moves. An
 * invented message here silently replaced the accepted codec's literal and no
 * assertion that checked version/code/path could see it -- the message is part
 * of the envelope.
 *
 * Same shape the codec itself uses when it re-anchors helper paths.
 */
function reanchorContractError(error: unknown, prefix: string): never {
  if (error instanceof ContractError) {
    throw new ContractError(error.code, `${prefix}${error.path}`, error.message);
  }
  throw error;
}

/**
 * Destination check through the ACCEPTED replay wrapper.
 *
 * The wrapper owns destination-before-digest ordering and the exact
 * scope_mismatch text. Calling it -- rather than comparing session names by
 * hand and inventing an error -- is what keeps the envelope identical for
 * sourced and local rows.
 *
 * Local rows carry no source triple, so a synthetic one is supplied purely to
 * reach the destination comparison; the digests are equal, so the wrapper can
 * only return or raise on DESTINATION. It never sees real local content.
 */
function assertReplayDestination(
  workspace: string,
  session: string,
  stored: Record<string, unknown>,
  itemPrefix: string,
): void {
  const storedNamespace = stored.source_namespace as string | null;
  const sourced = storedNamespace !== null;
  const namespace = sourced ? storedNamespace : "local";
  const messageId = sourced ? (stored.source_message_id as string) : (stored.public_id as string);
  const digest = sourced ? (stored.source_payload_digest as string) : "0".repeat(64);
  try {
    classifyMessageDestinationReplay(
      JSON.stringify({
        requested: { workspace_name: workspace, session_name: session },
        incoming: {
          source_namespace: namespace,
          source_message_id: messageId,
          source_payload_digest: digest,
        },
        existing: {
          workspace_name: stored.workspace_name,
          session_name: stored.session_name,
          source_namespace: namespace,
          source_message_id: messageId,
          source_payload_digest: digest,
          public_id: stored.public_id,
        },
      }),
    );
  } catch (error) {
    reanchorContractError(error, itemPrefix);
  }
}

/**
 * The exact safe wire envelope: version, code, path, message. No `name`.
 *
 * Only ACTUAL ContractError or PublicationError instances serialize as
 * themselves. An object merely shaped like one is unknown and normalizes to a
 * fixed recovery_required -- matching on a `name` property would let arbitrary
 * text out through the boundary.
 */
function safeErrorEnvelope(error: unknown): Record<string, unknown> {
  if (error instanceof PublicationError || error instanceof ContractError) {
    return error.toJSON() as unknown as Record<string, unknown>;
  }
  return new PublicationError("recovery_required", "").toJSON() as unknown as Record<string, unknown>;
}

/**
 * Walk an existing reply chain, bounded.
 *
 * Counts STORED ancestors traversed; the row being appended is not yet in the
 * chain and is not counted. 1024 visited is allowed, 1025 fails.
 */
async function assertReplyChain(
  adapter: DatasetAdapter,
  workspace: string,
  session: string,
  parent: Record<string, unknown>,
): Promise<void> {
  let cursor: Record<string, unknown> | null = parent;
  let visited = 0;
  const seen = new Set<string>();
  while (cursor !== null) {
    visited += 1;
    if (visited > 1024) failPublication("limit_exceeded", "");
    const encoded = encodeMessageRow(cursor);
    const id = encoded.public_id as string;
    if (seen.has(id)) failPublication("integrity_failure", "");
    seen.add(id);
    if (encoded.session_name !== session || encoded.workspace_name !== workspace) {
      failPublication("integrity_failure", "");
    }
    const next = encoded.in_reply_to as string | null;
    if (next === null) return;
    cursor = await contextOne(
      adapter,
      MESSAGES,
      `workspace_name = ${quote(workspace)} AND session_name = ${quote(session)} AND public_id = ${quote(next)}`,
    );
    if (cursor === null) failPublication("integrity_failure", "");
  }
}

export type ContextReaderService = ReturnType<typeof createContextReadMethods>;
export type ContextWriterService = ReturnType<typeof createContextWriterService>;

export type ContextReaderBundle = {
  publication: PublicationReaderService;
  taxonomy: TaxonomyReaderService;
  context: ContextReaderService;
};

export type ContextWriterBundle = {
  publication: Omit<PublicationWriterService, "close">;
  taxonomy: TaxonomyWriterService;
  context: ContextWriterService;
  close: () => Promise<void>;
};

export type ContextOptions = KnowledgeOptions & {
  /** Trusted CONFIGURATION, never request JSON. `null` selects local-only
   *  intake; a non-null value selects exactly that source namespace. It is not
   *  an authorization credential. */
  sourceNamespace: string | null;
  onContextBoundary?: ContextBoundaryHook;
};

/**
 * The configured namespace must be valid BEFORE a connection is opened.
 *
 * Nonempty only. There is deliberately NO byte ceiling here: the accepted
 * source codec does not impose one, and the request cap is not a
 * namespace-specific name bound. Inventing a 256-byte limit would be this
 * module adding a rule the contract does not state.
 */
function assertSourceNamespace(namespace: string | null): void {
  if (namespace === null) return;
  if (typeof namespace !== "string" || namespace.length === 0) {
    failPublication("invalid_request", "/sourceNamespace");
  }
}

/** Read all three facades over one gateless connection. Reads need no gate,
 *  no queue and no namespace configuration. */
export async function openContextReader(datasetRoot: string): Promise<ContextReaderBundle> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  const adapter = makeAdapter(await openPrivateConnection(canonical), () => {});
  return Object.freeze({
    publication: Object.freeze(makeReadMethods(adapter)),
    taxonomy: Object.freeze(createTaxonomyReadMethods(adapter)),
    context: Object.freeze(createContextReadMethods(adapter)),
  });
}

/**
 * One owner, three write facades.
 *
 * The bundle ALONE closes the owner: the nested publication facade carries its
 * data methods without `close`, and neither taxonomy nor context has one, so
 * no facade can release a gate another still depends on.
 *
 * `newRevisionId` stays required because the bundle offers publication.
 * Context operations never call it; allocating one lazily would hide a missing
 * dependency until the first publish.
 */
export async function openContextWriter(
  datasetRoot: string,
  options: ContextOptions,
): Promise<ContextWriterBundle> {
  // Namespace validity is decided BEFORE any connection is opened, so an
  // invalid configuration never takes the gate.
  assertSourceNamespace(options.sourceNamespace);

  const canonical = assertLocalDatasetRoot(datasetRoot);
  assertInheritedGate(canonical, options.env);
  if (OWNERS.has(canonical)) failPublication("writer_unavailable");
  const token = Symbol(canonical);
  OWNERS.set(canonical, token);

  let adapter: DatasetAdapter;
  try {
    adapter = makeAdapter(await openPrivateConnection(canonical), () => {
      if (OWNERS.get(canonical) === token) OWNERS.delete(canonical);
    });
  } catch (error) {
    OWNERS.delete(canonical);
    throw error;
  }

  const clock = options.clock ?? Date.now;
  const core = createOwnerCore(adapter, {
    onBoundary: options.onBoundary,
    onTaxonomyBoundary: options.onTaxonomyBoundary,
    onContextBoundary: options.onContextBoundary,
  });
  const publication = createPublicationWriterService(
    adapter,
    { clock, newRevisionId: options.newRevisionId },
    core,
  );
  const { close: _ownedByTheBundle, ...publicationData } = publication;

  return Object.freeze({
    publication: Object.freeze(publicationData),
    taxonomy: Object.freeze(createTaxonomyWriterService(adapter, core, { clock })),
    context: Object.freeze(
      createContextWriterService(adapter, core, { clock, sourceNamespace: options.sourceNamespace }),
    ),
    close: core.close,
  });
}

/**
 * The peer must exist AND hold a CURRENT active membership.
 *
 * Applied to replays as well as new items: a historical replay after the peer
 * left is refused. That refusal never deletes history -- reads still return the
 * message; only new or replayed appends require present membership.
 */
async function requireCurrentMembership(
  adapter: DatasetAdapter,
  workspace: string,
  session: string,
  peerName: string,
  path: string,
): Promise<void> {
  await adapter.refresh(PEERS);
  const peer = await contextOne(adapter, PEERS, `${contextScope(workspace)} AND name = ${quote(peerName)}`);
  if (peer === null) failPublication("invalid_reference", path);
  // Structural validity of the stored peer is required, not assumed.
  encodePeerRow(peer);

  await adapter.refresh(SESSION_PEERS);
  const membership = await contextOne(
    adapter,
    SESSION_PEERS,
    `${contextScope(workspace)} AND session_name = ${quote(session)} AND peer_name = ${quote(peerName)}`,
  );
  if (membership === null) failPublication("invalid_reference", path);
  if (encodeSessionPeerRow(membership).left_at !== null) failPublication("invalid_reference", path);
}
