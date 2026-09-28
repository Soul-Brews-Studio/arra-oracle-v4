// Barrel for the legacy `memories` table adapter (#22 style-split4a: one
// exported function per file, named after the file). Each function moved
// VERBATIM to its own `db.<fn>.ts`; module state (the LanceDB `conn`/`table`
// singletons) lives in `db.state.ts` so every split file shares one identity.
// This file only re-exports -- a re-export does not count as a function
// export under the one-function-per-file ratchet (app/server/test/
// one-function-per-file.test.ts), so it stays outside MULTI_EXPORT_ALLOWLIST.
export { db } from "./db.db";
export { insert, type NewMemory } from "./db.insert";
export { ensureFtsIndex } from "./db.ensureFtsIndex";
export { searchText } from "./db.searchText";
export { searchVector } from "./db.searchVector";
export { list, type MemoryFilters } from "./db.list";
export { getById } from "./db.getById";
export { backfill } from "./db.backfill";
export { stats } from "./db.stats";
