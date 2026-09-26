import { type Table } from "@lancedb/lancedb";
import { ftsIndexConfig } from "./fts.ftsIndexConfig";
import { ftsIndexMatches } from "./fts.ftsIndexMatches";
import { isFtsIndexOn } from "./fts.isFtsIndexOn";

/**
 * Rebuild the governed FTS index on `column` once the rows it does NOT cover
 * reach the rows it does; otherwise leave it alone. Answers whether it rebuilt.
 *
 * LanceDB still finds rows appended after a build -- it searches them
 * unindexed (measured) -- so staleness never costs an answer, only speed: an
 * index built once over the first rows would leave nearly every later row to
 * the slow path forever. Rebuilding when the unindexed rows catch up with the
 * indexed ones keeps at most half the table unindexed, and costs O(1)
 * amortized work per row (each rebuild at least doubles what is covered).
 *
 * Only an index that already is the governed one (`ftsIndexMatches`) is
 * refreshed, under its own name; building or repairing one is
 * `ensureFtsIndexOn`'s job, which the caller runs first. WRITER-ONLY, like
 * every index build.
 */
export async function refreshStaleFtsIndexOn(
  table: Pick<Table, "listIndices" | "indexStats" | "createIndex">,
  column: string,
): Promise<boolean> {
  const index = (await table.listIndices()).find((i) => isFtsIndexOn(column)(i) && ftsIndexMatches(i.indexDetails));
  if (index === undefined) return false;
  const stats = await table.indexStats(index.name);
  if (stats === undefined || stats.numUnindexedRows === 0 || stats.numUnindexedRows < stats.numIndexedRows) return false;
  await table.createIndex(column, { config: ftsIndexConfig(), replace: true, name: index.name });
  return true;
}
