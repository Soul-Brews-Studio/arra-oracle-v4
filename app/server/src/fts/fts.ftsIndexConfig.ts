import { Index } from "@lancedb/lancedb";
import { FTS_INDEX_OPTIONS } from "./fts.constants";

/**
 * A NEW native index config for every build. LanceDB consumes the object:
 * handing the same `Index` to a second `createIndex` fails with "attempt to
 * use an index more than once" (measured 2026-09-26), so there is no shared
 * instance to cache -- only the shared options it is built from.
 */
export function ftsIndexConfig(): Index {
  return Index.fts({ ...FTS_INDEX_OPTIONS });
}
