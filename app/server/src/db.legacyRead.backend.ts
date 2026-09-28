// R33 S2: which store backs the legacy `memories` read functions
// (`db.getById`, `db.list`, `db.searchText`, `db.searchVector`).
//
// Default is unchanged behaviour ("legacy": the `memories` LanceDB table).
// `ARRA_MEMORIES_BACKEND=target19` dark-launches the target-19 read path
// (S2 of docs/overnight/LEGACY-ROOT-RETIREMENT-PLAN.md): reads are served
// from nodes/revisions instead, mapped back to the exact legacy row shape.
// Writes are untouched either way -- this flag only gates reads.
export type MemoriesBackend = "legacy" | "target19";

export function backend(env: NodeJS.ProcessEnv = process.env): MemoriesBackend {
  return env.ARRA_MEMORIES_BACKEND === "target19" ? "target19" : "legacy";
}
