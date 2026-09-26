/**
 * Dataset adapters for the publication kernel.
 *
 * Everything here is PACKAGE-INTERNAL. The contracted factories live in
 * `service.ts`; nothing in this module is a request-facing service, and no
 * raw `Table` or `Connection` ever leaves it.
 *
 * Responsibilities, each one a decision rather than an accident:
 *
 * 1. Prove the inherited descriptor really is this dataset's gate -- by
 *    number, ownership, mode, link count and inode, on the descriptor itself.
 *    The environment says where to look and proves nothing.
 * 2. Resolve the dataset root through realpath, matching Python's
 *    `Path.resolve()`. A lexical resolve would let two spellings of one
 *    directory disagree about identity across the two languages.
 * 3. Refuse any dataset that is not the reviewed target19 SHAPE -- all 19
 *    tables, every field name, type and nullability -- before any mutation.
 * 4. Read timestamp and Int64 columns from RAW Arrow buffers, never a row
 *    accessor, so exact microsecond precision survives to the encoder.
 */

import { fstatSync, lstatSync, realpathSync, statSync } from "node:fs";
import { Type } from "apache-arrow";
import type { Connection, Table } from "@lancedb/lancedb";
import { failPublication } from "./errors";

/** Must match `writer_gate.LOCK_FILENAME`. */
export const LOCK_FILENAME = ".arra-writer.lock";
/** Must match `writer_gate.INHERITED_FD`; the descriptor number is fixed. */
export const INHERITED_FD = 42;
const ENV_FD = "ARRA_WRITER_FD";
const ENV_ROOT = "ARRA_WRITER_ROOT";

/**
 * `mcp_calls` and `connections` below are declared here, part of the
 * reviewed 19, but are NOT reachable through this dataset today.
 *
 * DECISIONS.md R5 (#103, #102): both are operations tables, written on every
 * admitted request straight to `ARRA_DATA_DIR` (`mcp/calls.ts`,
 * `mcp/connections.ts`) -- never through this gated knowledge dataset, and
 * never behind the exclusive writer gate this module enforces. The
 * `listMcpCalls`/`listConnections` readers (`knowledge/registry.ts`'s
 * `operations` entries, `mcp/calls.listMcpCalls.ts`,
 * `mcp/connections.listConnections.ts`) read `ARRA_DATA_DIR` for the same
 * reason. The copies of these two tables IN THIS dataset stay declared, so
 * `assertTargetDataset` keeps verifying their shape, but they stay EMPTY
 * until #34 migrates the operations tables over -- do not read them from
 * here as evidence that nothing was ever recorded.
 */
export const TARGET_SCHEMA: Readonly<Record<string, ReadonlyArray<readonly [string, string, boolean]>>> =
  Object.freeze({
  workspaces: [["id", "utf8", false], ["name", "utf8", false], ["created_at", "timestamp[us]", false], ["h_metadata", "utf8", true], ["internal_metadata", "utf8", true], ["configuration", "utf8", true], ["mission", "utf8", true]],
  peers: [["id", "utf8", false], ["name", "utf8", false], ["workspace_name", "utf8", false], ["h_metadata", "utf8", true], ["internal_metadata", "utf8", true], ["configuration", "utf8", true], ["created_at", "timestamp[us]", false]],
  sessions: [["id", "utf8", false], ["name", "utf8", false], ["workspace_name", "utf8", false], ["is_active", "bool", false], ["h_metadata", "utf8", true], ["internal_metadata", "utf8", true], ["configuration", "utf8", true], ["created_at", "timestamp[us]", false]],
  session_peers: [["workspace_name", "utf8", false], ["session_name", "utf8", false], ["peer_name", "utf8", false], ["configuration", "utf8", true], ["internal_metadata", "utf8", true], ["joined_at", "timestamp[us]", false], ["left_at", "timestamp[us]", true]],
  messages: [["id", "int64", false], ["public_id", "utf8", false], ["workspace_name", "utf8", false], ["session_name", "utf8", false], ["peer_name", "utf8", false], ["content", "utf8", false], ["token_count", "int64", false], ["seq_in_session", "int64", false], ["h_metadata", "utf8", true], ["internal_metadata", "utf8", true], ["created_at", "timestamp[us]", false], ["role", "utf8", true], ["in_reply_to", "utf8", true], ["read", "bool", true], ["read_at", "timestamp[us]", true], ["source_namespace", "utf8", true], ["source_message_id", "utf8", true], ["source_payload_digest", "utf8", true], ["source_created_at", "timestamp[us]", true], ["ingested_at", "timestamp[us]", false]],
  session_links: [["id", "utf8", false], ["workspace_name", "utf8", false], ["from_session_name", "utf8", false], ["to_session_name", "utf8", false], ["relation", "utf8", false], ["evidence_ref", "utf8", true], ["created_by_peer_name", "utf8", true], ["created_at", "timestamp[us]", false]],
  nodes: [["id", "utf8", false], ["workspace_name", "utf8", false], ["current_revision_id", "utf8", true], ["created_at", "timestamp[us]", false], ["updated_at", "timestamp[us]", false]],
  node_revisions: [["id", "utf8", false], ["workspace_name", "utf8", false], ["node_id", "utf8", false], ["revision_no", "int64", false], ["base_revision_id", "utf8", true], ["operation_id", "utf8", false], ["title", "utf8", false], ["body", "utf8", false], ["body_format", "utf8", false], ["fields", "utf8", false], ["author_peer_name", "utf8", true], ["observer_peer_name", "utf8", true], ["subject_peer_name", "utf8", true], ["session_name", "utf8", true], ["is_active", "bool", false], ["valid_from", "timestamp[us]", true], ["valid_to", "timestamp[us]", true], ["change_reason", "utf8", true], ["created_at", "timestamp[us]", false], ["schema_version", "int64", false], ["canonical_version", "utf8", false], ["content_digest", "utf8", false], ["term_snapshot_json", "utf8", false], ["link_snapshot_json", "utf8", false], ["h_metadata", "utf8", true], ["internal_metadata", "utf8", true]],
  node_revision_terms: [["workspace_name", "utf8", false], ["revision_id", "utf8", false], ["term_id", "utf8", false], ["vocabulary_id", "utf8", false], ["vocabulary_name_snapshot", "utf8", false], ["term_name_snapshot", "utf8", false], ["label_snapshot", "utf8", true], ["position", "int64", false]],
  revision_links: [["workspace_name", "utf8", false], ["revision_id", "utf8", false], ["position", "int64", false], ["relation", "utf8", false], ["target_kind", "utf8", false], ["target", "utf8", false], ["target_key", "utf8", false], ["excerpt", "utf8", true], ["content_hash", "utf8", true], ["captured_at", "timestamp[us]", true], ["capture_status", "utf8", false], ["note", "utf8", true]],
  supersede_log: [["id", "int64", false], ["workspace_name", "utf8", false], ["old_id", "utf8", false], ["old_revision_id", "utf8", false], ["old_title", "utf8", true], ["old_type", "utf8", true], ["old_source", "utf8", true], ["new_id", "utf8", true], ["new_revision_id", "utf8", true], ["new_title", "utf8", true], ["new_source", "utf8", true], ["reason", "utf8", false], ["peer_name", "utf8", true], ["superseded_at", "timestamp[us]", false], ["operation_id", "utf8", false], ["h_metadata", "utf8", true]],
  vocabularies: [["id", "utf8", false], ["name", "utf8", false], ["workspace_name", "utf8", false], ["label", "utf8", false], ["description", "utf8", true], ["kind", "utf8", false], ["term_policy", "utf8", false], ["cardinality", "utf8", false], ["required", "bool", false], ["hierarchy", "utf8", false], ["h_metadata", "utf8", true], ["internal_metadata", "utf8", true], ["created_at", "timestamp[us]", false]],
  terms: [["id", "utf8", false], ["workspace_name", "utf8", false], ["vocabulary_id", "utf8", false], ["name", "utf8", false], ["description", "utf8", true], ["parent_id", "utf8", true], ["weight", "float64", false], ["is_active", "bool", false], ["h_metadata", "utf8", true], ["created_at", "timestamp[us]", false]],
  traces: [["id", "utf8", false], ["name", "utf8", false], ["workspace_name", "utf8", false], ["session_name", "utf8", true], ["peer_name", "utf8", true], ["query", "utf8", false], ["mode", "utf8", true], ["session_id", "utf8", true], ["session_from_ts", "int64", true], ["session_to_ts", "int64", true], ["friction_score", "float64", true], ["confidence", "utf8", true], ["parent_id", "utf8", true], ["prev_id", "utf8", true], ["depth", "int64", false], ["status", "utf8", false], ["h_metadata", "utf8", true], ["internal_metadata", "utf8", true], ["created_at", "int64", false], ["updated_at", "int64", false]],
  trace_hits: [["workspace_name", "utf8", false], ["trace_id", "utf8", false], ["kind", "utf8", false], ["ref", "utf8", false], ["target", "utf8", false], ["line_start", "int64", true], ["line_end", "int64", true], ["excerpt", "utf8", true], ["content_hash", "utf8", true], ["captured_at", "timestamp[us]", true], ["note", "utf8", true], ["position", "int64", false]],
  search_chunks_v1: [["id", "utf8", false], ["workspace_name", "utf8", false], ["node_id", "utf8", false], ["revision_id", "utf8", false], ["chunk_index", "int64", false], ["text", "utf8", false], ["content_hash", "utf8", false], ["chunker_version", "utf8", false], ["embedding_profile", "utf8", false], ["embedding", "fixed_size_list<float32?>[384]", true], ["type_term_id", "utf8", false], ["term_ids", "list<utf8?>", false], ["observer_peer_name", "utf8", true], ["subject_peer_name", "utf8", true], ["session_name", "utf8", true], ["status", "utf8", false], ["attempts", "int64", false], ["last_attempt_at", "timestamp[us]", true], ["embedded_at", "timestamp[us]", true], ["error_code", "utf8", true]],
  mcp_calls: [["id", "utf8", false], ["workspace_name", "utf8", false], ["session_name", "utf8", true], ["peer_name", "utf8", true], ["tool", "utf8", false], ["status", "utf8", false], ["duration_ms", "int64", false], ["h_metadata", "utf8", true], ["internal_metadata", "utf8", true], ["created_at", "int64", false], ["connection_id", "utf8", true], ["principal", "utf8", true]],
  connections: [["id", "utf8", false], ["workspace_name", "utf8", false], ["method", "utf8", false], ["principal", "utf8", false], ["label", "utf8", false], ["user_agent", "utf8", true], ["remote_ip", "utf8", true], ["first_seen", "timestamp[us]", false], ["last_seen", "timestamp[us]", false], ["requests", "int64", false], ["tool_calls", "int64", false], ["last_tool", "utf8", true]],
  read_cursors: [["workspace_name", "utf8", false], ["peer_name", "utf8", false], ["session_name", "utf8", false], ["last_read_message_id", "utf8", true], ["last_read_at", "timestamp[us]", false]],
  }) as never;

/** The 19 reviewed target tables, in golden order. */
export const TARGET_TABLES = Object.freeze(Object.keys(TARGET_SCHEMA)) as readonly string[];

/**
 * Verify the inherited descriptor IS this dataset's gate.
 *
 * Every check runs on the DESCRIPTOR, not on a path that could have changed
 * identity since it was named. An ordinary unwrapped launch has no such
 * descriptor and is refused before any connection is opened.
 */
export function assertInheritedGate(canonicalRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  const declaredFd = env[ENV_FD];
  const declaredRoot = env[ENV_ROOT];
  if (typeof declaredFd !== "string" || typeof declaredRoot !== "string") {
    failPublication("writer_unavailable");
  }
  // The descriptor number is FIXED by the gate protocol; accepting an
  // arbitrary number would let any open file masquerade as the lock.
  if (declaredFd !== String(INHERITED_FD)) failPublication("writer_unavailable");
  if (realpathOrFail(declaredRoot) !== canonicalRoot) failPublication("writer_unavailable");

  let held: ReturnType<typeof fstatSync>;
  try {
    held = fstatSync(INHERITED_FD);
  } catch {
    return failPublication("writer_unavailable");
  }
  if (!held.isFile()) failPublication("writer_unavailable");
  if (held.uid !== process.getuid?.()) failPublication("writer_unavailable");
  // EXACTLY 0600. Checking only the group/other bits would accept 0400 or
  // 0700, neither of which is the mode the gate creates.
  if ((held.mode & 0o777) !== 0o600) failPublication("writer_unavailable");
  if (held.nlink !== 1) failPublication("writer_unavailable");

  // lstatSync, genuinely: statSync FOLLOWS a symlink, so a link planted at
  // the lock path could resolve to an inode that happens to match the held
  // descriptor. The comment previously said lstat while the code did not.
  let onDisk: ReturnType<typeof lstatSync>;
  try {
    onDisk = lstatSync(`${canonicalRoot}/${LOCK_FILENAME}`, { throwIfNoEntry: true });
  } catch {
    return failPublication("writer_unavailable");
  }
  if (!onDisk.isFile()) failPublication("writer_unavailable");
  if (held.ino !== onDisk.ino || held.dev !== onDisk.dev) failPublication("writer_unavailable");
}

function realpathOrFail(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return failPublication("unsupported_dataset");
  }
}

/**
 * A dataset root must be a local directory, resolved through REALPATH.
 *
 * Python's gate uses `Path.resolve()`, which follows symlinks. A lexical
 * resolve here would make the two languages disagree about which dataset an
 * alias names, and the shared lock would stop being shared.
 */
export function assertLocalDatasetRoot(datasetRoot: unknown): string {
  if (typeof datasetRoot !== "string" || !datasetRoot.trim()) failPublication("unsupported_dataset");
  if (datasetRoot.includes("://")) failPublication("unsupported_dataset");
  const canonical = realpathOrFail(datasetRoot);
  try {
    if (!statSync(canonical).isDirectory()) failPublication("unsupported_dataset");
  } catch {
    return failPublication("unsupported_dataset");
  }
  return canonical;
}

/**
 * Render an Arrow type in the golden's exact vocabulary.
 *
 * Keyed off the INSTALLED `Type` enum, matching the measured descriptor the
 * cross-language schema test already proves out. An earlier version here just
 * lowercased `type.toString()`, which collapsed every timestamp unit and
 * timezone into `timestamp[us]` and mis-spelled nested types -- so genuine
 * drift would have been accepted silently. An unknown type THROWS rather than
 * inventing a token: a type we cannot name is one we cannot verify.
 */
function describeType(type: {
  typeId: number;
  isSigned?: boolean;
  bitWidth?: number;
  precision?: number;
  unit?: number;
  timezone?: string | null;
  listSize?: number;
  children?: { type: unknown; nullable: boolean }[];
  toString(): string;
}): string {
  switch (type.typeId) {
    case Type.Bool:
      return "bool";
    case Type.Int:
      return `${type.isSigned ? "" : "u"}int${type.bitWidth}`;
    case Type.Float: {
      const precision: Record<number, string> = { 1: "float32", 2: "float64" };
      const rendered = precision[type.precision as number];
      if (!rendered) failPublication("unsupported_dataset");
      return rendered;
    }
    case Type.Utf8:
      return "utf8";
    case Type.LargeUtf8:
      // 64-bit offsets: a DIFFERENT physical type, never folded into utf8.
      return "large_utf8";
    case Type.Timestamp: {
      const unit = ["s", "ms", "us", "ns"][type.unit as number];
      if (!unit) failPublication("unsupported_dataset");
      return type.timezone == null ? `timestamp[${unit}]` : `timestamp[${unit},${type.timezone}]`;
    }
    case Type.List:
      return `list<${describeChild(type)}>`;
    case Type.FixedSizeList:
      return `fixed_size_list<${describeChild(type)}>[${type.listSize}]`;
    default:
      return failPublication("unsupported_dataset");
  }
}

function describeChild(type: { children?: { type: unknown; nullable: boolean }[] }): string {
  const field = type.children?.[0];
  if (!field) return failPublication("unsupported_dataset");
  return `${describeType(field.type as never)}${field.nullable ? "?" : ""}`;
}

/** Field descriptor: type spelling plus nullability, as the golden records it. */
export function describeField(field: { type: unknown; nullable: boolean }): string {
  return describeType(field.type as never);
}

/**
 * Verify all 19 tables AND their physical schemas against the golden.
 *
 * Name presence alone would accept a drifted dataset whose columns had
 * changed type or nullability underneath -- which is exactly the failure this
 * gate exists to catch. Nothing is written, no version is bumped and no row
 * is touched on rejection.
 */
export async function assertTargetDataset(connection: Connection): Promise<void> {
  // Ask for far more names than can exist: `tableNames` paginates, and a
  // silent truncation would read as "table absent".
  const present = new Set(await connection.tableNames({ limit: 1000 }));
  if (present.size >= 1000) failPublication("unsupported_dataset");

  for (const table of TARGET_TABLES) {
    if (!present.has(table)) failPublication("unsupported_dataset");
    const expected = TARGET_SCHEMA[table]!;
    let schema: { fields: { name: string; nullable: boolean; type: { toString(): string } }[] };
    try {
      schema = (await (await connection.openTable(table)).schema()) as never;
    } catch {
      return failPublication("unsupported_dataset");
    }
    if (schema.fields.length !== expected.length) failPublication("unsupported_dataset");
    for (let i = 0; i < expected.length; i++) {
      const [name, type, nullable] = expected[i]!;
      const actual = schema.fields[i]!;
      if (actual.name !== name) failPublication("unsupported_dataset");
      if (describeField(actual) !== type) failPublication("unsupported_dataset");
      if (actual.nullable !== nullable) failPublication("unsupported_dataset");
    }
  }
}

/** Single-quote escaping for SQL literals built from VALIDATED values only. */
export function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Read query results from RAW Arrow buffers.
 *
 * `toArray()` hands back row objects whose timestamp[us] values have already
 * been divided into lossy JS numbers and whose Int64s may have been coerced.
 * By the time we could inspect them the precision is gone, so this walks the
 * record batches and pulls each column's underlying values instead -- with
 * validity checked per row rather than assumed.
 */
/**
 * Decode an ALREADY OBTAINED Arrow table into raw rows.
 *
 * Extracted from `rawRows` so an ordered/projected query can decode through
 * exactly the same path instead of growing a second, subtly different one --
 * a duplicate decoder is how a Number fallback creeps back in on one side only.
 *
 * Carries DATA, not authority: it takes an Arrow table a caller already holds
 * and returns plain records. It opens nothing, holds nothing and cannot reach
 * a connection, table handle or owner.
 */
export function decodeArrowRows(arrow: {
  batches: ReadonlyArray<{
    numRows: number;
    schema: { fields: ReadonlyArray<{ name: string }> };
    getChildAt(index: number): { isValid(row: number): boolean; get(row: number): unknown; data: ReadonlyArray<{ values?: unknown; offset?: number }> } | null;
  }>;
}): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];

  for (const batch of arrow.batches) {
    for (let row = 0; row < batch.numRows; row++) {
      const record: Record<string, unknown> = {};
      for (let col = 0; col < batch.schema.fields.length; col++) {
        const field = batch.schema.fields[col]!;
        const vector = batch.getChildAt(col);
        if (vector === null) {
          record[field.name] = null;
          continue;
        }
        if (!vector.isValid(row)) {
          record[field.name] = null;
          continue;
        }
        const typed = describeField(field as never);
        if (typed === "timestamp[us]") {
          // The RAW int64 microseconds, before any Date conversion.
          const data = vector.data[0];
          const values = data?.values as BigInt64Array | undefined;
          const offset = (data?.offset ?? 0) + row;
          record[field.name] =
            values !== undefined && offset < values.length
              ? values[offset]
              : BigInt(Number(vector.get(row)));
          continue;
        }
        const value = vector.get(row);
        record[field.name] = typed === "int64" && typeof value !== "bigint" ? BigInt(value as number) : value;
      }
      out.push(record);
    }
  }
  return out;
}

/**
 * Unchanged behaviour: where, optional limit, then decode.
 *
 * The decoding half now lives in `decodeArrowRows`; nothing else about this
 * function moved. It still has NO ordering, so a bare `limit` here still
 * returns arbitrary rows -- callers that need an extremum must order.
 */
export async function rawRows(table: Table, predicate: string, limit?: number): Promise<Record<string, unknown>[]> {
  let q = table.query().where(predicate);
  if (limit !== undefined) q = q.limit(limit);
  return decodeArrowRows(await q.toArrow());
}

// No connection factory is exported. `service.ts` opens its own connection
// and keeps it private, so this module offers no route to a raw handle.

export type { Connection, Table };
