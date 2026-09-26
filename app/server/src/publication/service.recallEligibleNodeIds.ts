import { getRecallEligibility } from "./service.getRecallEligibility";
import { type DatasetAdapter } from "./service.types";

/**
 * SEAM (#29 eligibility): the ONE place retrieval asks "may this node be
 * recalled?" -- DECISIONS.md R18 D3: recall paths exclude superseded and
 * retired nodes.
 *
 * It calls the public `getRecallEligibility` kernel method with exactly the
 * bytes a transport caller would send, once per node, so retrieval inherits
 * that method's rule unchanged -- today "no `supersede_log` row names the node
 * as `old_id`", which covers both retirement and supersession. The #29 slice
 * is extending eligibility concurrently (validity windows, a transport-supplied
 * `as_of`, `service.evaluateEligibility.ts`); when that lands, the body of the
 * loop below is the only line to change, and a batched check can replace the
 * per-node call without touching either search.
 *
 * Cost, stated: several scoped reads per node. Callers pass only nodes that
 * already have a current candidate chunk, and memoize the answer per request.
 */
export async function recallEligibleNodeIds(
  reader: DatasetAdapter,
  workspace: string,
  nodeIds: readonly string[],
): Promise<Set<string>> {
  const eligible = new Set<string>();
  for (const nodeId of nodeIds) {
    const request = new TextEncoder().encode(JSON.stringify({ workspace_name: workspace, node_id: nodeId }));
    if ((await getRecallEligibility(reader, request)).eligible) eligible.add(nodeId);
  }
  return eligible;
}
