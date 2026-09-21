import { deriveLinkRows, deriveTermRows } from "./association";
import { parseSnapshotArray } from "./service.parseSnapshotArray";

/** The complete expected derived sets for ONE accepted revision. */
export function expectedSets(
  workspace: string,
  selected: Record<string, unknown>,
): { terms: Record<string, unknown>[]; links: Record<string, unknown>[] } {
  const revisionId = selected.id as string;
  return {
    terms: deriveTermRows(
      workspace,
      revisionId,
      parseSnapshotArray(selected.term_snapshot_json, ""),
    ),
    links: deriveLinkRows(
      workspace,
      revisionId,
      parseSnapshotArray(selected.link_snapshot_json, ""),
    ),
  };
}
