// Opens the SAME LanceDB dataset the Rust migration wrote. Query only -- no
// createTable, no overwrite. Proves the schema round-trips Rust -> TS, not just
// that a new table can be made.
// Run: bun install && bun run index.ts

import { connect } from "@lancedb/lancedb";

const db = await connect("../migrate-rust/data");
const tbl = await db.openTable("memories");

console.log(`opened   table=memories version=${await tbl.version()} rows=${await tbl.countRows()}`);

const schema = await tbl.schema();
console.log("schema (as seen from TS):");
for (const f of schema.fields) {
  console.log(`  ${f.name.padEnd(20)} ${f.type.toString()}  nullable=${f.nullable}`);
}

// dimension check: a 1024-d query vector against `embedding` must not throw a
// mismatch error. Table is empty (migration only), so this proves wiring, not recall.
const zeroVec = new Array(1024).fill(0);
const nearest = await tbl.vectorSearch(zeroVec).limit(5).toArray();
console.log(`vectorSearch(1024-d) -> ${nearest.length} rows (table is empty, expected 0)`);

const filtered = await tbl.query().where("workspace_name = 'demo'").limit(5).toArray();
console.log(`where(workspace_name='demo') -> ${filtered.length} rows (table is empty, expected 0)`);
