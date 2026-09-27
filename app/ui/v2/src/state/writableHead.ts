import type { RevisionRow } from "../api/knowledge";

/** The head and history the Knowledge view may WRITE against: only rows that
 *  belong to the selected node. `useKnowledge.refresh` has no stale-response
 *  guard, so a late head for the previous node can land after "new" opened a
 *  draft; publishing then would send that node's head as the draft's base,
 *  and Correct would offer revisions of a node no longer on screen. */
export function writableHead(
  selected: string | null,
  head: RevisionRow | null,
  history: RevisionRow[],
): { head: RevisionRow | null; revisions: RevisionRow[] } {
  if (selected === null || head === null || head.node_id !== selected) return { head: null, revisions: [] };
  return { head, revisions: history.filter((r) => r.node_id === selected) };
}
