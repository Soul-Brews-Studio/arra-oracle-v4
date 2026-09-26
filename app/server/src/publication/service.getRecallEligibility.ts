import { parseGetRecallEligibility } from "./lifecycle";
import { toInt64Text } from "./rows";
import { NODES, SUPERSEDE_LOG } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { evaluateNodeEligibility, type EligibilityReason } from "./service.evaluateEligibility";
import { requireWorkspace } from "./service.requireWorkspace";
import { selectedMaximum } from "./service.selectedMaximum";
import { type DatasetAdapter } from "./service.types";

/**
 * #29 slice B (overnight R7): delegates to the centralized
 * `evaluateNodeEligibility` and gains `reasons` as an ADDITIVE field.
 * `eligible` and `witness_event_id` keep their pre-slice meaning exactly --
 * `witness_event_id` is still the highest `supersede_log.id` in the
 * requesting workspace, unrelated to `asOf` or the new predicates.
 *
 * `requestTimeMs` is the validity-window `as_of`, in epoch milliseconds. The
 * real transport (`knowledge/registry.ts`, shared by HTTP and MCP) always
 * supplies it as real request time -- this function never reads a clock
 * itself. The parameter is optional ONLY for the handful of existing
 * generic in-process test harnesses that call every context method with a
 * single `requestBytes` argument and predate this slice; none of them
 * assert on the new `reasons` field, so the fallback below never changes an
 * existing assertion. New tests that care about `reasons` pass an explicit
 * value.
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
