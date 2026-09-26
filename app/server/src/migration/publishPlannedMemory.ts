import { type EvidenceWriterBundle } from "../publication/service.types";
import { buildRevisionRequest } from "./buildRevisionRequest";
import { errorOutcome } from "./errorOutcome";
import { type Emit, type PlannedMemory, type PlannedWorkspace, type WorkerControls } from "./plan.types";

/**
 * Publish one legacy memory as a node's accepted first revision.
 *
 * The kernel stamps created_at from `clock()`, so the clock is set to the
 * LEGACY created_at (already proven millisecond-exact by the plan); the
 * revision id is the plan's deterministic id, consumed exactly once. A
 * kernel refusal is a report line, not an exception: the memory is rejected,
 * the source still holds it.
 */
export async function publishPlannedMemory(
  bundle: EvidenceWriterBundle,
  controls: WorkerControls,
  workspace: PlannedWorkspace,
  memory: PlannedMemory,
  emit: Emit,
): Promise<boolean> {
  const base = { kind: "memory", workspace: workspace.workspace_name, legacy_id: memory.legacy_id };
  controls.now = memory.created_at_ms;
  controls.nextRevisionId = memory.revision_id;
  try {
    const outcome = await bundle.publication.publishRevision(buildRevisionRequest(workspace, memory));
    if (outcome.outcome === "conflict") {
      emit({ ...base, outcome: "conflict", code: `conflict_${outcome.reason}` });
      return false;
    }
    if (outcome.node_id !== memory.node_id || outcome.revision_id !== memory.revision_id) {
      // An idempotent replay of a DIFFERENT prior allocation would mean the
      // candidate was not fresh. Refuse to call that migrated.
      emit({ ...base, outcome: "conflict", code: "unexpected_allocation" });
      return false;
    }
    emit({ ...base, outcome: outcome.outcome, node_id: outcome.node_id, revision_id: outcome.revision_id,
           content_digest: outcome.content_digest });
    return true;
  } catch (error) {
    emit({ ...base, ...errorOutcome(error) });
    return false;
  } finally {
    controls.nextRevisionId = null;
  }
}
