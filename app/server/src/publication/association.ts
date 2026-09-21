/**
 * Association request grammar, cursor validation and physical row derivation.
 *
 * PURE by contract. No SDK import, and nothing here acquires, retains or
 * returns a connection, table, adapter or owner. Materialization and evidence
 * persistence stay private in service.ts, so this module can be exercised
 * without a dataset and cannot become a back door to one.
 *
 * TWO envelopes, neither new:
 *   - governed ContractError / arra-error/v1 for parse, shape, value and the
 *     cursor scope_mismatch. Those come from the shared codec helpers, so RFC
 *     6901 escaping and deterministic unknown-key ordering are inherited.
 *   - PublicationError / arra-publication-error/v1 for STORED-state failures,
 *     always at the ROOT path.
 *
 * Contract: app/docs/contracts/association-evidence-v1.md
 *
 * This file is a thin barrel: one function/type per file under
 * ./association/, re-exported here so every importer keeps working unchanged.
 */

export {
  REVISION_MODES,
  type RevisionMode,
  MAX_PAGE_LIMIT,
  MAX_VISITED_NODES,
  MAX_SELECTED_REVISIONS,
  MAX_EXAMINED_POSITIONS,
  MAX_RESULT_WIRE_BYTES,
  TERM_FIELDS,
  LINK_FIELDS,
  CURSOR_KEYS,
} from "./association/constants";

export {
  type GetRevisionAssociationsRequest,
  parseGetRevisionAssociations,
} from "./association/parse-get-revision-associations";
export {
  type ReconcileRequest,
  parseReconcileRevisionAssociations,
} from "./association/parse-reconcile-revision-associations";
export { type ScanCursor } from "./association/types";
export {
  type ScanDependentsRequest,
  parseScanDependents,
} from "./association/parse-scan-dependents";

export { deriveTermRows } from "./association/derive-term-rows";
export { deriveLinkRows } from "./association/derive-link-rows";
