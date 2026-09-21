import { TERM_FIELDS } from "./association.constants";
import { ordered } from "./association.ordered";
import { snapshotNullableText } from "./association.snapshotNullableText";
import { snapshotPosition } from "./association.snapshotPosition";
import { snapshotText } from "./association.snapshotText";

/** Derive the complete expected TERM rows from a normalized snapshot. */
export function deriveTermRows(
  workspace: string,
  revisionId: string,
  entries: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown>[] {
  return entries.map((entry) =>
    ordered(
      {
        workspace_name: workspace,
        revision_id: revisionId,
        term_id: snapshotText(entry.term_id),
        vocabulary_id: snapshotText(entry.vocabulary_id),
        vocabulary_name_snapshot: snapshotText(entry.vocabulary_name_snapshot),
        term_name_snapshot: snapshotText(entry.term_name_snapshot),
        // Historical rows are NOT revalidated against today's term names,
        // activity or policy; the snapshot is what it is.
        label_snapshot: snapshotNullableText(entry.label_snapshot),
        position: snapshotPosition(entry.position),
      },
      TERM_FIELDS,
    ),
  );
}
