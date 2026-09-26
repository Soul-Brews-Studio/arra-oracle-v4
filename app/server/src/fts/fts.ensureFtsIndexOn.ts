import { type IndexConfig, type Table } from "@lancedb/lancedb";
import { ftsIndexConfig } from "./fts.ftsIndexConfig";
import { ftsIndexMatches } from "./fts.ftsIndexMatches";

const isFtsOn = (column: string) => (index: IndexConfig) =>
  ["FTS", "INVERTED"].includes(index.indexType.toUpperCase()) && index.columns.includes(column);
const label = (index: IndexConfig) => `${index.name}:${index.indexType}`;

/**
 * Leave exactly one FTS index on `column`, built from `FTS_INDEX_OPTIONS`.
 *
 * - `replace: false` (startup): an index whose live details already match is
 *   KEPT -- no rebuild, no new table version, so a restart costs nothing. One
 *   that differs (an older deployment's `icu`) is rebuilt once, under its OWN
 *   name with `replace: true`, and matches from then on.
 * - `replace: true` (the explicit `maintenance:reindex` operation): rebuilt
 *   regardless.
 *
 * Any further FTS index on the same column is dropped. A second index is
 * accepted by LanceDB, but which one a search uses is not ours to choose, so a
 * leftover `icu` index could keep answering after the upgrade (#10 analysis).
 * The kept index is the one that already matches, when there is one, so the
 * collapse itself never forces a rebuild. Order is build-then-drop: a failure
 * part way leaves an extra index to collapse next time, never none.
 */
export async function ensureFtsIndexOn(
  table: Pick<Table, "listIndices" | "createIndex" | "dropIndex">,
  column: string,
  replace: boolean,
): Promise<string[]> {
  const fts = (await table.listIndices()).filter(isFtsOn(column));
  const keep = fts.find((index) => ftsIndexMatches(index.indexDetails)) ?? fts[0];
  if (replace || keep === undefined || !ftsIndexMatches(keep.indexDetails)) {
    await table.createIndex(column, {
      config: ftsIndexConfig(),
      replace: true,
      ...(keep === undefined ? {} : { name: keep.name }),
    });
  }
  for (const other of fts) {
    if (other !== keep) await table.dropIndex(other.name);
  }
  return (await table.listIndices()).map(label);
}
