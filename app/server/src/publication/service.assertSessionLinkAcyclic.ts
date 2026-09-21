import { failPublication } from "./errors";
import { type SessionRelation, MAX_CYCLE_VISITED, encodeSessionLinkRow } from "./session-link";
import { quote } from "./storage";
import { SESSION_LINKS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/**
 * Bounded FORWARD reachability walk for the `continues`/`forked_from` cycle
 * policy. `related_to` is symmetric and calls none of this -- no traversal,
 * no bound.
 *
 * Starting from `toSession` (the parent side of the edge being proposed),
 * follow the SAME directed relation FORWARD over its OUT-edges: at each
 * visited session, find its own outgoing edge(s) of this relation
 * (`from_session_name = current`) and continue to their `to_session_name`.
 * This is reachability FROM `toSession`, not ancestry back to it.
 *
 * A session can have MULTIPLE outgoing edges of the same relation, so this is
 * a real DAG walk, not a single-parent chain: a revisited node is ordinarily
 * legal (X->Y, X->Z, Y->W, Z->W is a diamond, not a cycle). A proper
 * gray/black DFS -- explicit stack, not recursion, so a frame can be closed
 * on its way back out -- tells the two apart:
 *   - `onPath` (gray) marks a node currently on the active DFS path. Popping
 *     an unexpanded frame already in `onPath` is a BACK EDGE: a real
 *     directed cycle, `integrity_failure` at ROOT, whether it was already
 *     stored or only completed by this request.
 *   - `black` marks a node whose whole subtree already finished clean.
 *     Popping an unexpanded frame already in `black` is a legitimate
 *     reconvergence (a cross/forward edge in a legal DAG) and is silently
 *     skipped -- it is proven acyclic already.
 * Reaching `fromSession` itself (the child side of the PROPOSED edge) is a
 * distinct, simpler fault, checked first: the caller asked for an edge that
 * closes a loop back onto its own new child. That is the caller's bad
 * request, not stored corruption, so it is `invalid_request` at
 * `/to_session_name` -- the same precedent `assertAncestryIsSafe` (taxonomy)
 * already sets for reaching the term being moved.
 *
 * Each out-edge query is itself bounded and UNORDERED (`DatasetAdapter.query`
 * has no ordering guarantee): a wide node with more than `MAX_CYCLE_VISITED`
 * out-edges of this relation would let the query return an ARBITRARY subset,
 * silently defeating the walk on exactly the row that would have proven a
 * cycle. That is refused outright rather than walked partially, exactly as
 * `listMessages` never truncates a page it cannot prove complete. 1024
 * distinct finished (`black`) sessions is allowed; the 1025th, or any single
 * node with more than 1024 out-edges of this relation, is `limit_exceeded`
 * at ROOT -- the same bound as reply chains and revision ancestry.
 */
export async function assertSessionLinkAcyclic(
  writer: DatasetAdapter,
  workspace: string,
  fromSession: string,
  toSession: string,
  rel: SessionRelation,
): Promise<void> {
  if (rel === "related_to") return;
  await writer.refresh(SESSION_LINKS);
  const onPath = new Set<string>();
  const black = new Set<string>();
  const stack: Array<{ node: string; expanded: boolean }> = [{ node: toSession, expanded: false }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.expanded) {
      // Closing the frame: this node's whole subtree finished clean.
      onPath.delete(frame.node);
      black.add(frame.node);
      if (black.size > MAX_CYCLE_VISITED) failPublication("limit_exceeded", "");
      continue;
    }

    const node = frame.node;
    // The PROPOSED edge's own child, reached while walking its parent's
    // reachable set: the request itself would close the loop. Caller fault,
    // checked before anything that would name this stored state instead.
    if (node === fromSession) failPublication("invalid_request", "/to_session_name");
    // On the active path: a genuine back edge, whether it was already
    // stored or only completed by the edge this request proposes.
    if (onPath.has(node)) failPublication("integrity_failure", "");
    // Fully finished already: a legal reconvergence (a DAG diamond), not a
    // cycle. Silently skipped -- this subtree is proven acyclic already.
    if (black.has(node)) continue;

    onPath.add(node);
    stack.push({ node, expanded: true });

    const rows = await writer.query(
      SESSION_LINKS,
      `${contextScope(workspace)} AND from_session_name = ${quote(node)} AND relation = ${quote(rel)}`,
      MAX_CYCLE_VISITED + 1,
    );
    // UNORDERED and limited: more rows than the bound means the query itself
    // cannot prove it saw every out-edge, so this refuses rather than walking
    // an arbitrary, possibly cycle-hiding, subset.
    if (rows.length > MAX_CYCLE_VISITED) failPublication("limit_exceeded", "");
    for (const row of rows) {
      const encoded = encodeSessionLinkRow(row);
      stack.push({ node: encoded.to_session_name as string, expanded: false });
    }
  }
}
