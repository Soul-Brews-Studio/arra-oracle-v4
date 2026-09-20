// Opens the schema created by the active Python migration. This file never defines the schema -- if the table
// is missing, that is a migration that did not run, not something to paper over.

import { connect, Index, type Connection, type Table } from "@lancedb/lancedb";
import { embed, embedOne, DIMS } from "./embed";
import { DATA_DIR, storageOptions, storageInfo } from "./storage";

const TABLE = "memories";

/** After this many failures a row stops being retried and stays `failed`. */
const MAX_SYNC_ATTEMPTS = 5;

let conn: Connection | null = null;
let table: Table | null = null;

// A Table handle is a pinned snapshot, not a live view: it keeps serving the
// version it was opened at, so writes from another process (a Python migration,
// a second server, a backfill worker) stay invisible until checkoutLatest().
// Read-your-own-writes within one process works without it -- cross-process does not.
export async function db(): Promise<Table> {
  conn ??= await connect(DATA_DIR, { storageOptions: storageOptions() });
  if (!table) {
    const names = await conn.tableNames();
    if (!names.includes(TABLE)) {
      throw new Error(`table '${TABLE}' not found in ${DATA_DIR}. Run 'just migrate run' first.`);
    }
    table = await conn.openTable(TABLE);
    return table;
  }
  await table.checkoutLatest();
  return table;
}

export type NewMemory = {
  name: string;
  content: string;
  workspace_name?: string;
  type?: string;
  session_name?: string | null;
  peer_name?: string | null;
  subject_peer_name?: string | null;
};

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

function requiredBank(bank: string | undefined): string {
  if (!bank?.trim()) throw new Error("bank is required");
  return bank;
}

// Insert canonical text only. Model I/O belongs to explicit backfill until the
// durable async reconciliation worker in #30 exists; remember must ACK even if
// the configured embedder hangs forever.
export async function insert(m: NewMemory): Promise<{ id: string; embedded: boolean }> {
  const tbl = await db();
  const id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const row = {
    id,
    name: m.name,
    workspace_name: m.workspace_name ?? "default",
    session_name: m.session_name ?? null,
    peer_name: m.peer_name ?? null,
    subject_peer_name: m.subject_peer_name ?? null,
    type: m.type ?? "note",
    content: m.content,
    embedding: null as number[] | null,
    created_at: new Date(),
    valid_from: null,
    valid_to: null,
    sync_state: "pending",
    last_sync_at: null as Date | null,
    sync_attempts: 0,
    superseded_by: null,
    superseded_at: null,
    is_active: true,
    h_metadata: null,
    internal_metadata: null,
  };

  // Canonical text is durable before any model/network call. Derived search
  // state may lag and is explicitly visible through sync_state.
  await tbl.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([row]);
  return { id, embedded: false };
}

export async function ensureFtsIndex(replace = true): Promise<string[]> {
  const tbl = await db();
  const existing = await tbl.listIndices();
  if (!replace && existing.some((index) => ["FTS", "INVERTED"].includes(index.indexType.toUpperCase()) && index.columns.includes("content"))) {
    return existing.map((index) => `${index.name}:${index.indexType}`);
  }
  await tbl.createIndex("content", {
    config: Index.fts({ baseTokenizer: "icu" }), // icu segments Thai; `simple` cannot
    replace,
  });
  return (await tbl.listIndices()).map((i) => `${i.name}:${i.indexType}`);
}

const wireInteger = (value: bigint | number) => {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return Number.isSafeInteger(value) ? value : String(value);
};

const wireTime = (value: unknown) => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint" || typeof value === "number") return wireInteger(value);
  return String(value);
};

const clean = (rows: any[]) =>
  rows.map((r) => ({
    id: r.id,
    name: r.name,
    workspace_name: r.workspace_name,
    session_name: r.session_name ?? null,
    peer_name: r.peer_name ?? null,
    subject_peer_name: r.subject_peer_name ?? null,
    type: r.type,
    content: r.content,
    created_at: wireTime(r.created_at),
    valid_from: wireTime(r.valid_from),
    valid_to: wireTime(r.valid_to),
    sync_state: r.sync_state,
    last_sync_at: wireTime(r.last_sync_at),
    sync_attempts: wireInteger(r.sync_attempts ?? 0),
    superseded_by: r.superseded_by ?? null,
    superseded_at: wireTime(r.superseded_at),
    is_active: Boolean(r.is_active),
    h_metadata: r.h_metadata ?? null,
    embedded: r.embedding != null,
    score: r._score ?? undefined,
    distance: r._distance ?? undefined,
  }));

export async function searchText(q: string, bank?: string, limit = 10) {
  const tbl = await db();
  let s = tbl.search(q, "fts");
  if (bank) s = s.where(`workspace_name = '${bank.replace(/'/g, "''")}'`);
  s = s.limit(limit);
  return clean(await s.toArray());
}

export async function searchVector(q: string, bank?: string, limit = 10) {
  const tbl = await db();
  const vec = await embedOne(q);
  let s = tbl.vectorSearch(vec);
  if (bank) s = s.where(`workspace_name = '${bank.replace(/'/g, "''")}'`);
  s = s.limit(limit);
  return clean(await s.toArray());
}

export interface MemoryFilters {
  type?: string;
  session_name?: string;
  peer_name?: string;
  subject_peer_name?: string;
  sync_state?: string;
  is_active?: boolean;
}

export async function list(bank?: string, limit = 50, filters: MemoryFilters = {}) {
  const tbl = await db();
  let q = tbl.query();
  const predicates: string[] = [];
  if (bank) predicates.push(`workspace_name = ${quote(bank)}`);
  for (const key of ["type", "session_name", "peer_name", "subject_peer_name", "sync_state"] as const) {
    const value = filters[key];
    if (value !== undefined) predicates.push(`${key} = ${quote(value)}`);
  }
  if (filters.is_active !== undefined) predicates.push(`is_active = ${filters.is_active}`);
  if (predicates.length) q = q.where(predicates.join(" AND "));
  q = q.limit(limit);
  return clean(await q.toArray());
}

export async function getById(bank: string, id: string) {
  const scopedBank = requiredBank(bank);
  const tbl = await db();
  const rows = await tbl
    .query()
    .where(`workspace_name = ${quote(scopedBank)} AND id = ${quote(id)}`)
    .limit(1)
    .toArray();
  return clean(rows)[0] ?? null;
}

// The backfill: find rows with no vector, embed them, write vectors back by id.
export async function backfill(batch = 32) {
  const tbl = await db();
  // MAX_ATTEMPTS bounds the poison-row loop §4.6.1 warns about.
  const pending = await tbl
    .query()
    .where(`embedding IS NULL AND sync_attempts < ${MAX_SYNC_ATTEMPTS}`)
    .limit(batch)
    .toArray();
  if (pending.length === 0) return { embedded: 0, remaining: 0 };

  // An embedder outage must COUNT against each row, not silently retry forever.
  // §4.6.1: sync_attempts is what lets a backfill give up on a poison row.
  let vectors: number[][];
  try {
    vectors = await embed(pending.map((r: any) => r.content));
  } catch (e) {
    await tbl.mergeInsert("id").whenMatchedUpdateAll().execute(
      pending.map((r: any) => ({
        ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "embedding")),
        embedding: null,
        sync_state: "failed",
        sync_attempts: typeof r.sync_attempts === "bigint"
          ? r.sync_attempts + 1n
          : Number(r.sync_attempts ?? 0) + 1,
      })),
    );
    throw e;
  }
  await tbl
    .mergeInsert("id")
    .whenMatchedUpdateAll()
    .execute(
      pending.map((r: any, i: number) => ({
        ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "embedding")),
        embedding: vectors[i],
        sync_state: "synced",
        last_sync_at: new Date(),
      })),
    );

  const remaining = (await tbl.query().where("embedding IS NULL").toArray()).length;
  return { embedded: pending.length, remaining };
}

export async function stats(bank: string) {
  const scopedBank = requiredBank(bank);
  const tbl = await db();
  const scope = `workspace_name = ${quote(scopedBank)}`;
  const rows = await tbl.countRows(scope);
  const unembedded = await tbl.countRows(`${scope} AND embedding IS NULL`);
  return {
    table: TABLE,
    storage: storageInfo(),
    rows,
    embedded: rows - unembedded,
    unembedded,
    version: await tbl.version(),
    dims: DIMS,
    indices: (await tbl.listIndices()).map((i) => `${i.name}:${i.indexType}`),
  };
}
