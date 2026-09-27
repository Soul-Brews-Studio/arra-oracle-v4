import { type ContextFreshness } from "./chat";
import { MESSAGES, NODES, NODE_REVISIONS, SESSION_PEERS, SUPERSEDE_LOG } from "./service.constants";
import { type DatasetAdapter } from "./service.types";

/** The tables a context or representation read derives from. */
const SOURCE_TABLES = [MESSAGES, SESSION_PEERS, NODES, NODE_REVISIONS, SUPERSEDE_LOG] as const;

/**
 * Slice 10 (DESIGN.md §12 "freshness"): assembly time plus the version of
 * every source table as this reader observed it. Read-only: `version` names
 * the checked-out table version and writes nothing.
 *
 * `asOf` is the transport's request time (the registry passes `Date.now()`),
 * the same value the eligibility window uses, so one read reports one time.
 * Versions are sampled AFTER assembly, so they are an upper bound on what the
 * read saw -- assembly is not an atomic snapshot and this says no more.
 */
export async function contextFreshness(reader: DatasetAdapter, asOf: number): Promise<ContextFreshness> {
  const source_watermarks: Record<string, number> = {};
  for (const table of SOURCE_TABLES) source_watermarks[table] = await reader.version(table);
  return { assembled_at: new Date(asOf).toISOString(), source_watermarks, index_watermark: "unknown" };
}
