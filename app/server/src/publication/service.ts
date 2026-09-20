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
import { failPublication, isContractError, PublicationError } from "./errors";
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
function createPublicationWriterService(
  writer: DatasetAdapter,
  options: { clock: Clock; newRevisionId: IdSource; onBoundary?: BoundaryHook },
): PublicationWriterService {
  const reads = makeReadMethods(writer);
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
  const boundary = async (name: PublicationBoundary, wroteAlready: boolean): Promise<void> => {
    if (options.onBoundary === undefined) return;
    try {
      await options.onBoundary(name);
    } catch {
      if (wroteAlready) {
        poisoned = true;
        failPublication("recovery_required");
      }
      failPublication("invalid_request");
    }
  };

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
          if (!(error instanceof PublicationError)) failPublication("recovery_required");
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
      poisoned = true;
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
      if (error instanceof PublicationError) throw error;
      return failPublication("recovery_required");
    }
  };

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
      poisoned = true;
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
      poisoned = true;
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
        poisoned = true;
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
    close: () => {
      // First call does the work; every later call awaits that same result.
      // `closing` is still set synchronously here, so a request enqueued after
      // close is rejected exactly as before.
      closeOnce ??= (async () => {
        closing = true;
        await queue.catch(() => undefined);
        writer.release();
        releaseInheritedGate();
      })();
      return closeOnce;
    },
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

  return createPublicationWriterService(adapter, {
    clock: options.clock ?? Date.now,
    newRevisionId: options.newRevisionId,
    onBoundary: options.onBoundary,
  });
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
