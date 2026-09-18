// Opens what Rust created. This file never defines the schema -- if the table
// is missing, that is a migration that did not run, not something to paper over.

import { connect, Index, type Connection, type Table } from "@lancedb/lancedb";
import { embed, embedOne, DIMS } from "./embed";

const DATA_DIR = process.env.ARRA_DATA_DIR ?? "../data";
const TABLE = "memories";

let conn: Connection | null = null;
let table: Table | null = null;

// A Table handle is a pinned snapshot, not a live view: it keeps serving the
// version it was opened at, so writes from another process (the Rust migration,
// a second server, a backfill worker) stay invisible until checkoutLatest().
// Read-your-own-writes within one process works without it -- cross-process does not.
export async function db(): Promise<Table> {
  conn ??= await connect(DATA_DIR);
  if (!table) {
    const names = await conn.tableNames();
    if (!names.includes(TABLE)) {
      throw new Error(`table '${TABLE}' not found in ${DATA_DIR}. Run the Rust migration first.`);
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
};

// Insert. Embeds inline when the embedder is up; on failure the row still lands
// with embedding=null and /api/backfill picks it up later.
export async function insert(m: NewMemory): Promise<{ id: string; embedded: boolean }> {
  const tbl = await db();
  const id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  let embedding: number[] | null = null;
  try {
    embedding = await embedOne(m.content);
  } catch {
    embedding = null;
  }

  await tbl.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([
    {
      id,
      name: m.name,
      workspace_name: m.workspace_name ?? "default",
      session_name: m.session_name ?? null,
      peer_name: m.peer_name ?? null,
      subject_peer_name: null,
      type: m.type ?? "note",
      content: m.content,
      embedding,
      created_at: new Date(),
      valid_from: null,
      valid_to: null,
      sync_state: embedding ? "synced" : "pending",
      superseded_by: null,
      superseded_at: null,
      is_active: true,
      h_metadata: null,
      internal_metadata: null,
    },
  ]);
  return { id, embedded: embedding !== null };
}

export async function ensureFtsIndex(): Promise<string[]> {
  const tbl = await db();
  await tbl.createIndex("content", {
    config: Index.fts({ baseTokenizer: "icu" }), // icu segments Thai; `simple` cannot
    replace: true,
  });
  return (await tbl.listIndices()).map((i) => `${i.name}:${i.indexType}`);
}

const clean = (rows: any[]) =>
  rows.map((r) => ({
    id: r.id,
    name: r.name,
    workspace_name: r.workspace_name,
    type: r.type,
    content: r.content,
    sync_state: r.sync_state,
    embedded: r.embedding != null,
    score: r._score ?? undefined,
    distance: r._distance ?? undefined,
  }));

export async function searchText(q: string, bank?: string, limit = 10) {
  const tbl = await db();
  let s = tbl.search(q, "fts").limit(limit);
  if (bank) s = s.where(`workspace_name = '${bank.replace(/'/g, "''")}'`);
  return clean(await s.toArray());
}

export async function searchVector(q: string, bank?: string, limit = 10) {
  const tbl = await db();
  const vec = await embedOne(q);
  let s = tbl.vectorSearch(vec).limit(limit);
  if (bank) s = s.where(`workspace_name = '${bank.replace(/'/g, "''")}'`);
  return clean(await s.toArray());
}

export async function list(bank?: string, limit = 50) {
  const tbl = await db();
  let q = tbl.query().limit(limit);
  if (bank) q = q.where(`workspace_name = '${bank.replace(/'/g, "''")}'`);
  return clean(await q.toArray());
}

// The backfill: find rows with no vector, embed them, write vectors back by id.
export async function backfill(batch = 32) {
  const tbl = await db();
  const pending = await tbl.query().where("embedding IS NULL").limit(batch).toArray();
  if (pending.length === 0) return { embedded: 0, remaining: 0 };

  const vectors = await embed(pending.map((r: any) => r.content));
  await tbl
    .mergeInsert("id")
    .whenMatchedUpdateAll()
    .execute(
      pending.map((r: any, i: number) => ({
        ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "embedding")),
        embedding: vectors[i],
        sync_state: "synced",
      })),
    );

  const remaining = (await tbl.query().where("embedding IS NULL").toArray()).length;
  return { embedded: pending.length, remaining };
}

export async function stats() {
  const tbl = await db();
  const rows = await tbl.countRows();
  const unembedded = (await tbl.query().where("embedding IS NULL").toArray()).length;
  return {
    table: TABLE,
    data_dir: DATA_DIR,
    rows,
    embedded: rows - unembedded,
    unembedded,
    version: await tbl.version(),
    dims: DIMS,
    indices: (await tbl.listIndices()).map((i) => `${i.name}:${i.indexType}`),
  };
}
