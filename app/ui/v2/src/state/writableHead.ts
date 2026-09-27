import type { RevisionRow } from "../api/knowledge";

/** The head and history the Knowledge view may WRITE against: only rows that
 *  belong to the selected node. `useKnowledge.refresh` now drops a response
 *  for a node no longer selected (ui-stale), but until the new node's first
 *  answer lands the PREVIOUS node's head is still in state; publishing then
 *  would send that node's head as the draft's base, and Correct would offer
 *  revisions of a node no longer on screen. This stays the write-side fence. */
export function writableHead(
  selected: string | null,
  head: RevisionRow | null,
  history: RevisionRow[],
): { head: RevisionRow | null; revisions: RevisionRow[] } {
  if (selected === null || head === null || head.node_id !== selected) return { head: null, revisions: [] };
  return { head, revisions: history.filter((r) => r.node_id === selected) };
}
