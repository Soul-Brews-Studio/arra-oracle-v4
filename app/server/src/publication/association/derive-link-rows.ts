import { ContractError } from "../../contracts/errors";
import { targetOp, type TargetResult } from "../../contracts/evidence-v1";
import { parseStrict, type JcsValue } from "../../contracts/jcs";
import { failPublication } from "../errors";
import { LINK_FIELDS } from "./constants";
import { ordered } from "./ordered";
import { snapshotNullableText } from "./snapshot-nullable-text";
import { snapshotPosition } from "./snapshot-position";
import { snapshotText } from "./snapshot-text";

/** Derive the complete expected LINK rows from a normalized snapshot. */
export function deriveLinkRows(
  workspace: string,
  revisionId: string,
  entries: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown>[] {
  return entries.map((entry) => {
    let derived: TargetResult;
    try {
      // A snapshot entry is a PLAIN object: parseSnapshotArray uses JSON.parse,
      // and the accepted link validator reads entries as plain objects. The
      // codec wants a JcsValue, so the target is re-read through the GOVERNED
      // parser rather than converted by hand -- a local object-to-Map walker
      // would be a second parser with its own escaping and depth rules.
      const targetValue = parseStrict(JSON.stringify(entry.target ?? null), []);
      // target text and target_key from the SAME codec result, so the two can
      // never disagree.
      derived = targetOp(workspace, entry.target_kind as JcsValue, targetValue, []);
    } catch (error) {
      // ONLY a governed codec rejection means the stored snapshot is corrupt.
      // A catch-all here would relabel a programming fault -- a TypeError, a
      // bad call -- as stored corruption and hide it behind a plausible
      // integrity_failure.
      if (!(error instanceof ContractError)) throw error;
      return failPublication("integrity_failure");
    }
    return ordered(
      {
        workspace_name: workspace,
        revision_id: revisionId,
        position: snapshotPosition(entry.position),
        relation: snapshotText(entry.relation),
        target_kind: snapshotText(entry.target_kind),
        target: derived.target_json,
        target_key: derived.target_key,
        // Ordinary capture annotations are not identity and are not proof of
        // retrieval; they are retained exactly, including empty strings.
        excerpt: snapshotNullableText(entry.excerpt),
        content_hash: snapshotNullableText(entry.content_hash),
        captured_at: snapshotNullableText(entry.captured_at),
        capture_status: snapshotText(entry.capture_status),
        note: snapshotNullableText(entry.note),
      },
      LINK_FIELDS,
    );
  });
}
