import { getRecallEligibility } from "./service.getRecallEligibility";
import { type DatasetAdapter } from "./service.types";

/**
 * SEAM (#29 eligibility): the ONE place retrieval asks "may this node be
 * recalled?" -- DECISIONS.md R18 D3: recall paths exclude superseded and
 * retired nodes.
 *
 * It calls the public `getRecallEligibility` kernel method with exactly the
 * bytes a transport caller would send, once per node, so retrieval inherits
 * that method's rule unchanged: since #29 slice B that is DESIGN.md §9's
 * centralized predicates (`service.evaluateNodeEligibility.ts`) -- no terminal
 * `supersede_log` event (retirement or supersession), `is_active`, and the
 * `[valid_from, valid_to)` window at `requestTimeMs`. That `as_of` is the
 * transport's real request time (`knowledge/registry.ts`), passed the same way
 * the registry passes it to `getRecallEligibility` itself, so the kernel
 * takes no clock on a live call (R7 #29); one value serves the whole request.
 * A batched check can replace the per-node call without touching either
 * search.
 *
 * Cost, stated: several scoped reads per node. Callers pass only nodes that
 * already have a current candidate chunk, and memoize the answer per request.
 */
export async function recallEligibleNodeIds(
  reader: DatasetAdapter,
  workspace: string,
  nodeIds: readonly string[],
  requestTimeMs?: number,
): Promise<Set<string>> {
  const eligible = new Set<string>();
  for (const nodeId of nodeIds) {
    const request = new TextEncoder().encode(JSON.stringify({ workspace_name: workspace, node_id: nodeId }));
    if ((await getRecallEligibility(reader, request, requestTimeMs)).eligible) eligible.add(nodeId);
  }
  return eligible;
}
