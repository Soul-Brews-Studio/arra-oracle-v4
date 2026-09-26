import { failPublication } from "./errors";
import { parseSnapshotArray } from "./service.parseSnapshotArray";

/**
 * Every term id assigned on one accepted revision's `term_snapshot_json`,
 * independent of vocabulary -- the general form `service.deriveNodeType.ts`
 * specializes to the single reserved `type` entry.
 *
 * K3 (overnight R18, `docs/overnight/V3-PARITY.md` §5/§7): `listNodes`'s
 * `all_term_ids`/`any_term_ids` filters match against THIS set, never against
 * a live `node_revision_terms` join -- that projection only exists once
 * `reconcileRevisionAssociations` has run for a revision, so filtering on it
 * would silently miss every unreconciled node (the same reasoning
 * `service.listNodes.ts`'s own `type_term` comment states for the same
 * field). The snapshot is written WITH the revision and is never behind a
 * separate write.
 */
export function snapshotTermIds(encodedRevision: Record<string, unknown>): string[] {
  const parsed = parseSnapshotArray(encodedRevision.term_snapshot_json, "");
  const ids: string[] = [];
  for (const entry of parsed) {
    const termId = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>).term_id : undefined;
    if (typeof termId !== "string") failPublication("integrity_failure", "");
    ids.push(termId);
  }
  return ids;
}
