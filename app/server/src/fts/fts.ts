/**
 * The shared lexical-search module (R14 / #10; R7 for the #30 chunk index,
 * which `publication/service.makeAdapter.ts` builds and reads through the
 * same options, status check and overfetch bound).
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
export { escapeLike } from "./fts.escapeLike";
export { ftsIndexConfig } from "./fts.ftsIndexConfig";
export { ftsIndexMatches } from "./fts.ftsIndexMatches";
export { ftsIndexStatus } from "./fts.ftsIndexStatus";
export { isFtsIndexOn } from "./fts.isFtsIndexOn";
export { likeContainsPredicate } from "./fts.likeContainsPredicate";
export { likePrefixPredicate } from "./fts.likePrefixPredicate";
export { overfetch } from "./fts.overfetch";
export { refreshStaleFtsIndexOn } from "./fts.refreshStaleFtsIndexOn";
export { substringSearch } from "./fts.substringSearch";
