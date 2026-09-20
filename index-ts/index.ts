// FTS indexing on the table Rust migrated. Text goes in now, vectors come later --
// `embedding` stays null through all of this, which is the point.
// Run: bun install && bun run index.ts

import { connect, Index } from "@lancedb/lancedb";

const db = await connect("../migrate-rust/data");
const tbl = await db.openTable("memories");

const now = new Date();
const sample = [
  { id: "m1", name: "trigram-vs-unicode61", workspace_name: "demo", type: "note",
    content: "FTS5 unicode61 พบ ความ แค่ 5 ครั้ง แต่ trigram พบ 435 ครั้ง",
    sync_state: "pending", is_active: true, created_at: now },
  { id: "m2", name: "icu-tokenizer", workspace_name: "demo", type: "note",
    content: "ความทรงจำของ agent ต้องหาเจอทั้งไทยและอังกฤษ",
    sync_state: "pending", is_active: true, created_at: now },
  { id: "m3", name: "lance-is-rust", workspace_name: "demo", type: "decision",
    content: "LanceDB is Rust-native, so the embedding column lives on the table",
    sync_state: "pending", is_active: true, created_at: now },
  { id: "m4", name: "other-bank", workspace_name: "other", type: "note",
    content: "ความ appears here too, but in a different bank",
    sync_state: "pending", is_active: true, created_at: now },
];

await tbl.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(sample);
console.log(`inserted rows=${await tbl.countRows()} version=${await tbl.version()}`);

const nullVecs = await tbl.query().where("embedding IS NULL").toArray();
console.log(`embedding IS NULL -> ${nullVecs.length} of ${await tbl.countRows()} rows (index first, embed later)`);

await tbl.createIndex("content", { config: Index.fts({ baseTokenizer: "icu" }), replace: true });
console.log(`indices  ${(await tbl.listIndices()).map((i) => `${i.name}:${i.indexType}`).join(" ")}`);

const show = async (q: string, where?: string) => {
  let s = tbl.search(q, "fts").limit(10);
  if (where) s = s.where(where);
  const rows = await s.toArray();
  console.log(`fts ${JSON.stringify(q)}${where ? ` where ${where}` : ""} -> ${rows.length}: ` +
    rows.map((r: any) => r.id).join(" "));
};

await show("ความ");
await show("ความทรงจำ");
await show("Rust");
await show("ความ", "workspace_name = 'demo'");
