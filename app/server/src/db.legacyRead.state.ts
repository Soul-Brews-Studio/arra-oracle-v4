import { type KnowledgeReaderBundle } from "./knowledge/registry";

// Module state only (no exported function -- mirrors `db.state.ts`'s own
// carve-out from the one-function-per-file ratchet). One process-lifetime
// slot for the target-19 READER bundle the S2 legacy-shaped read path uses.
export const target19ReaderState: { cached: Promise<KnowledgeReaderBundle> | null } = { cached: null };
