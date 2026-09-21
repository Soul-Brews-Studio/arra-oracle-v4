import { encodeSupersedeLogRow } from "./lifecycle";
import { quote } from "./storage";
import { SUPERSEDE_LOG } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { type DatasetAdapter, type LifecycleEventInput, type LifecycleReplayClassification } from "./service.types";

/**
 * Classify (workspace_name, operation_id) BEFORE any other state check runs.
 *
 * Contract precedence is request validity, WORKSPACE, scoped target
 * identity, stored integrity, foreign refs, expected value, persistence
 * (registerNamed's own rule) -- so the workspace check runs first, above the
 * operation lookup, not after it.
 *
 * The operation lookup then OUTRANKS every other state check, exactly as
 * `publish` states for its own replay (service.ts: "Operation lookup
 * OUTRANKS a stale current base on an accepted retry"): an exact replay must
 * return the retained event with no clock sample and no write regardless of
 * what has happened to the successor, the pin or anything else since the
 * original write. `supersedeNode` calls this FIRST, before walking the
 * replacement chain or resolving the successor -- otherwise a successor that
 * later gains a new revision, grows its chain past the bound, or sits behind
 * a stored cycle elsewhere would turn an idempotent replay into a thrown
 * fault, naming a field the caller got right at the time.
 */
export async function classifyLifecycleReplay(
  writer: DatasetAdapter,
  requireWorkspaceRow: (workspace: string) => Promise<void>,
  input: LifecycleEventInput,
): Promise<LifecycleReplayClassification> {
  await requireWorkspaceRow(input.workspace_name);
  await writer.refresh(SUPERSEDE_LOG);
  const existingOperation = await contextOne(
    writer,
    SUPERSEDE_LOG,
    `workspace_name = ${quote(input.workspace_name)} AND operation_id = ${quote(input.operation_id)}`,
  );
  if (existingOperation === null) return { replay: false };

  const encoded = encodeSupersedeLogRow(existingOperation);
  const successorMatches =
    input.successor === null
      ? encoded.new_id === null && encoded.new_revision_id === null
      : encoded.new_id === input.successor.new_id &&
        encoded.new_revision_id === input.successor.new_revision_id;
  const matches =
    encoded.old_id === input.node_id &&
    encoded.old_revision_id === input.expected_revision_id &&
    encoded.reason === input.reason &&
    encoded.peer_name === input.peer_name &&
    successorMatches;
  // Exact replay: the ORIGINAL row, no clock sample, no write.
  if (matches) return { replay: true, outcome: { outcome: "idempotent", row: encoded } };
  // Same key, different payload: a classification, not invalid bytes.
  return { replay: true, outcome: { outcome: "conflict", reason: "operation_digest", row: encoded } };
}
