/**
 * #29 (Parent #28) node lifecycle -- the PURE half.
 *
 * Request grammar and the stored-row codec for supersede/retire events, with
 * no SDK, connection or owner import. Everything here is decidable from bytes
 * alone, or from one already-selected stored row.
 *
 * MEASURED: `supersede_log` carries NO event-kind column. supersede vs retire
 * is distinguished ONLY by `new_id`/`new_revision_id` being null (a
 * retirement) or both non-null (a supersession) -- there is no third
 * spelling, and a row with exactly one of the pair null is corruption this
 * codec refuses rather than guesses at.
 *
 * This file is a re-export barrel: each function below moved VERBATIM into
 * `lifecycle.<fn>.ts` (Nat style, one exported function per file, named
 * after the file). Kept here so importers and the frozen-contract line
 * citations below do not churn. Barrel only -- the split files import each
 * other and lifecycle.constants.ts directly, never through this file.
 */

export { MAX_HISTORY_LIMIT, type SupersedeNodeRequest, type RetireNodeRequest, type GetRecallEligibilityRequest, type ListLifecycleHistoryRequest, SUPERSEDE_LOG_FIELDS } from "./lifecycle.constants";
export { parseSupersedeNode } from "./lifecycle.parseSupersedeNode";
export { parseRetireNode } from "./lifecycle.parseRetireNode";
export { parseGetRecallEligibility } from "./lifecycle.parseGetRecallEligibility";
export { parseListLifecycleHistory } from "./lifecycle.parseListLifecycleHistory";
export { encodeSupersedeLogRow } from "./lifecycle.encodeSupersedeLogRow";
export { isSupersedeEvent } from "./lifecycle.isSupersedeEvent";
