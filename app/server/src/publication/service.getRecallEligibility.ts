import { parseGetRecallEligibility } from "./lifecycle";
import { toInt64Text } from "./rows";
import { NODES, SUPERSEDE_LOG } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { evaluateNodeEligibility, type EligibilityReason } from "./service.evaluateNodeEligibility";
import { requireWorkspace } from "./service.requireWorkspace";
import { selectedMaximum } from "./service.selectedMaximum";
import { type DatasetAdapter } from "./service.types";

/**
 * #29 slice B (overnight R7): delegates to the centralized
 * `evaluateNodeEligibility` and gains `reasons` as an ADDITIVE field.
 *
 * `witness_event_id` keeps its exact pre-slice meaning: still the highest
 * `supersede_log.id` in the requesting workspace, unrelated to `asOf` or the
 * new predicates. `eligible` does NOT keep its pre-slice (contract §5)
 * meaning -- fix round correction, this doc previously claimed it did.
 * lifecycle-v1.md §5 defines `eligible` as solely "no `supersede_log` row
 * exists for this node"; this slice's amendment REPLACES that rule with
 * DESIGN.md §9's five predicates (also requiring `is_active` and the
 * `[valid_from, valid_to)` window), so a node with `is_active: false` or an
 * expired/not-yet-open window is now ineligible even with zero
 * `supersede_log` rows -- a real, disclosed behaviour change, not an
 * additive one.
 *
 * `requestTimeMs` is the validity-window `as_of`, in epoch milliseconds. The
 * real transport (`knowledge/registry.ts`, shared by HTTP and MCP) always
 * supplies it as real request time on every LIVE call. Fix round correction:
 * this function is NOT clock-free -- the very next line falls back to
 * `Date.now()` when the caller omits `requestTimeMs`, which earlier
 * versions of this comment (and of `service.evaluateNodeEligibility.ts`'s
 * and `registry.ts`'s comments) incorrectly denied. The fallback exists
 * ONLY for the handful of existing generic in-process test harnesses that
 * call every context method with a single `requestBytes` argument and
 * predate this slice; none of them assert on the new `reasons` field, so
 * the fallback never changes an existing assertion. New tests that care
 * about `reasons` (or about `asOf` at all) pass an explicit value.
 */
export async function getRecallEligibility(
  reader: DatasetAdapter,
  requestBytes: Uint8Array,
  requestTimeMs?: number,
): Promise<{ eligible: boolean; witness_event_id: string; reasons: EligibilityReason[] }> {
  const request = parseGetRecallEligibility(requestBytes);
  await requireWorkspace(reader, request.workspace_name);

  await reader.refresh(NODES);
  await reader.refresh(SUPERSEDE_LOG);
  const maxId = await selectedMaximum(reader, SUPERSEDE_LOG, "id", contextScope(request.workspace_name));
  const witness = maxId === null ? 0n : maxId;

  const asOf = requestTimeMs ?? Date.now();
  const result = await evaluateNodeEligibility(reader, request.workspace_name, request.node_id, asOf);

  return { eligible: result.eligible, witness_event_id: toInt64Text(witness), reasons: result.reasons };
}
