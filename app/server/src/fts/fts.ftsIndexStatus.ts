import type { IndexConfig } from "@lancedb/lancedb";
import { ftsIndexMatches } from "./fts.ftsIndexMatches";
import { isFtsIndexOn } from "./fts.isFtsIndexOn";

/**
 * What a READER may conclude about the lexical index on `column`, from the
 * live `listIndices()` alone -- it never builds or repairs one:
 *
 * - `ready`: an index built from `FTS_INDEX_OPTIONS` exists, so a trigram
 *   lookup is trustworthy.
 * - `missing`: no FTS index. A trigram lookup would not fail, it would answer
 *   `[]` silently (measured on 0.38.0 for a never-indexed table), so this is
 *   not a state to query through.
 * - `mismatched`: only an index with other details (an older `icu`). Its
 *   answers would be `icu` answers -- blind to ลืม inside หลงลืม -- not ours.
 *
 * Anything but `ready` means the caller answers by the bounded substring scan
 * and says so; the index is the writer's to build.
 */
export function ftsIndexStatus(indices: readonly IndexConfig[], column: string): "ready" | "missing" | "mismatched" {
  const fts = indices.filter(isFtsIndexOn(column));
  if (fts.length === 0) return "missing";
  return fts.some((index) => ftsIndexMatches(index.indexDetails)) ? "ready" : "mismatched";
}
