import { type EvidenceWriterBundle } from "../publication/service.types";
import { applyLifecycleEvent } from "./applyLifecycleEvent";
import { deriveProjections } from "./deriveProjections";
import { type Emit, type PlannedWorkspace, type WorkerControls } from "./plan.types";
import { publishPlannedMemory } from "./publishPlannedMemory";
import { seedWorkspaceTaxonomy } from "./seedWorkspaceTaxonomy";

/**
 * One workspace, in the only order the references allow:
 *
 *   taxonomy seed + R11 tags -> memories (legacy created_at order)
 *     -> their derived projections -> lifecycle events (legacy superseded_at order)
 *
 * Supersession runs after EVERY memory is published, because a successor must
 * already be an accepted head to be pinned. Every planned memory and event
 * gets exactly one line, even when an earlier step was refused.
 */
export async function migrateWorkspace(
  bundle: EvidenceWriterBundle,
  controls: WorkerControls,
  intakeMs: number,
  workspace: PlannedWorkspace,
  published: Set<string>,
  emit: Emit,
): Promise<void> {
  const ws = workspace.workspace_name;
  const seeded = await seedWorkspaceTaxonomy(bundle, controls, intakeMs, workspace, emit);
  if (!seeded) {
    for (const memory of workspace.memories) {
      emit({ kind: "memory", workspace: ws, legacy_id: memory.legacy_id, outcome: "error", code: "taxonomy_unavailable", path: "" });
    }
    for (const event of workspace.lifecycle) {
      emit({ kind: "lifecycle", workspace: ws, legacy_key: event.legacy_key, outcome: "error", code: "taxonomy_unavailable" });
    }
    return;
  }

  for (const memory of workspace.memories) {
    if (await publishPlannedMemory(bundle, controls, workspace, memory, emit)) published.add(memory.legacy_id);
  }
  for (const memory of workspace.memories) {
    if (published.has(memory.legacy_id)) await deriveProjections(bundle, controls, ws, memory, emit);
  }
  for (const event of workspace.lifecycle) {
    const successor = event.new_node_id === null
      ? null
      : workspace.memories.find((memory) => memory.node_id === event.new_node_id);
    const ready = published.has(event.node_legacy_id)
      && (successor === null || (successor !== undefined && published.has(successor.legacy_id)));
    if (!ready) {
      emit({ kind: "lifecycle", workspace: ws, legacy_key: event.legacy_key, outcome: "error", code: "node_not_published" });
      continue;
    }
    await applyLifecycleEvent(bundle, controls, event, emit);
  }
}
