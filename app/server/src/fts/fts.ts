/**
 * The shared lexical-search module (R14 / #10; R7 for the #30 chunk index).
 *
 * One options constant, one way to build and verify the index, one substring
 * contract for answers. Store-agnostic: every function takes the LanceDB table
 * (or the slice of it it needs), the column and a trusted scope predicate, so
 * the legacy `memories` store (`db.ts`) and a later store build and search
 * identically.
 *
 * This file is a thin barrel: the implementation lives beside it as
 * `fts.<functionName>.ts`, one function per file.
 */

export {
  FTS_CANDIDATE_CEILING,
  FTS_CANDIDATE_FACTOR,
  FTS_INDEX_OPTIONS,
  FTS_MIN_QUERY_CODE_POINTS,
} from "./fts.constants";
export type { FtsMatch, FtsResult } from "./fts.constants";
export { containsFolded } from "./fts.containsFolded";
export { ensureFtsIndexOn } from "./fts.ensureFtsIndexOn";
export { ftsIndexConfig } from "./fts.ftsIndexConfig";
export { ftsIndexMatches } from "./fts.ftsIndexMatches";
export { likeContainsPredicate } from "./fts.likeContainsPredicate";
export { substringSearch } from "./fts.substringSearch";
