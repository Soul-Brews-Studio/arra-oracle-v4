import { type EvidenceWriterBundle } from "../publication/service.types";
import { errorOutcome } from "./errorOutcome";
import { type Emit, type PlannedLifecycleEvent, type WorkerControls } from "./plan.types";
import { requestBytes } from "./requestBytes";

/**
 * One legacy supersede/retire row as a kernel lifecycle event.
 *
 * Pinned to the revisions this migration just published; `superseded_at` is
 * the LEGACY time (the kernel samples the clock only for a genuinely new
 * event). The reason was already backfilled by the plan when the legacy
 * row had none (R17: "legacy: reason not recorded", counted in the report).
 * A second event on the same node comes back `already_terminal` and is
 * reported rejected -- append-only, never overwritten.
 */
export async function applyLifecycleEvent(
  bundle: EvidenceWriterBundle,
  controls: WorkerControls,
  event: PlannedLifecycleEvent,
  emit: Emit,
): Promise<void> {
  const base = { kind: "lifecycle", workspace: event.workspace, legacy_key: event.legacy_key, event: event.kind };
  controls.now = event.at_ms;
  const common = {
    workspace_name: event.workspace,
    node_id: event.node_id,
    expected_revision_id: event.expected_revision_id,
    reason: event.reason,
    peer_name: event.peer_name,
    operation_id: event.operation_id,
  };
  try {
    const outcome = event.kind === "supersede"
      ? await bundle.context.supersedeNode(requestBytes({
          ...common, new_node_id: event.new_node_id, new_revision_id: event.new_revision_id,
        }))
      : await bundle.context.retireNode(requestBytes(common));
    if (outcome.outcome === "conflict") {
      emit({ ...base, outcome: "conflict", code: `conflict_${outcome.reason}` });
      return;
    }
    emit({ ...base, outcome: outcome.outcome });
  } catch (error) {
    emit({ ...base, ...errorOutcome(error) });
  }
}
