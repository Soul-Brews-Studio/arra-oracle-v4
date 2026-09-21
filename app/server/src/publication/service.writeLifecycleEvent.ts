import { classifyLifecycleReplay } from "./service.classifyLifecycleReplay";
import { type Clock, type DatasetAdapter, type LifecycleEventInput, type LifecycleWriteOutcome, type OwnerCore } from "./service.types";
import { writeLifecycleEventFresh } from "./service.writeLifecycleEventFresh";

/**
 * retireNode's entrypoint: classify the replay first, then run the fresh
 * path only when no prior event under this operation_id exists. retireNode
 * has no successor to resolve and no chain to walk, so there is nothing
 * between the two steps -- unlike supersedeNode, which must classify FIRST
 * and only then resolve its successor on the genuinely-fresh path.
 */
export async function writeLifecycleEvent(
  writer: DatasetAdapter,
  core: OwnerCore,
  options: { clock: Clock },
  requireWorkspaceRow: (workspace: string) => Promise<void>,
  writeRow: (
    table: string,
    row: Record<string, unknown>,
    verify: () => Promise<Record<string, unknown>>,
    expected: Record<string, unknown>,
    fields: readonly string[],
    wroteAlready: boolean,
  ) => Promise<Record<string, unknown>>,
  input: LifecycleEventInput,
): Promise<LifecycleWriteOutcome> {
  const classified = await classifyLifecycleReplay(writer, requireWorkspaceRow, input);
  if (classified.replay) return classified.outcome;
  return writeLifecycleEventFresh(writer, core, options, writeRow, input);
}
