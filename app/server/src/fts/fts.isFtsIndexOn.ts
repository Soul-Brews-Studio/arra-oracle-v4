import type { IndexConfig } from "@lancedb/lancedb";

/**
 * Whether a `listIndices()` entry is a full-text index over `column`. LanceDB
 * has reported the type as both `FTS` and `INVERTED` across versions, so both
 * spellings count.
 */
export function isFtsIndexOn(column: string): (index: IndexConfig) => boolean {
  return (index) => ["FTS", "INVERTED"].includes(index.indexType.toUpperCase()) && index.columns.includes(column);
}
