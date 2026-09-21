import { failPublication } from "./errors";
import { RESERVED_TYPE_VOCABULARY } from "./service.constants";
import { parseSnapshotArray } from "./service.parseSnapshotArray";

/**
 * The "type" a node's head revision carries, derived from the reserved
 * `type` entry inside `node_revisions.term_snapshot_json`.
 *
 * There is no `new_type`/`old_type` origin anywhere else in the schema: this
 * is the ONLY place that value ever comes from. Publication already enforces
 * exactly one `type` assignment per accepted revision, so anything else found
 * here is stored corruption, not a request error.
 */
export function deriveNodeType(encodedRevision: Record<string, unknown>): string {
  // Delegates to the accepted snapshot parser rather than re-running the
  // same string/JSON.parse/array checks locally: a second copy is how the
  // two drift.
  const parsed = parseSnapshotArray(encodedRevision.term_snapshot_json, "");
  const typeEntries = parsed.filter(
    (entry) => entry !== null && typeof entry === "object" && entry.vocabulary_name_snapshot === RESERVED_TYPE_VOCABULARY,
  );
  if (typeEntries.length !== 1) failPublication("integrity_failure", "");
  const termName = typeEntries[0]!.term_name_snapshot;
  if (typeof termName !== "string") failPublication("integrity_failure", "");
  return termName;
}
