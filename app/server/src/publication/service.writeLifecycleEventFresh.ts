import { PublicationError, failPublication } from "./errors";
import { SUPERSEDE_LOG_FIELDS, encodeSupersedeLogRow } from "./lifecycle";
import { encodeNodeRow, encodeRevisionRow, microsToTimestamp } from "./rows";
import { quote } from "./storage";
import { INT64_CEILING, NODES, NODE_REVISIONS, SUPERSEDE_LOG } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { deriveNodeType } from "./service.deriveNodeType";
import { selectedMaximum } from "./service.selectedMaximum";
import { type Clock, type DatasetAdapter, type LifecycleEventInput, type LifecycleWriteOutcome, type OwnerCore } from "./service.types";

/**
 * The genuinely-fresh half of one retire/supersede event.
 *
 * Callable ONLY after `classifyLifecycleReplay` has already returned
 * `{ replay: false }` for this exact input: everything here assumes no prior
 * event under this operation_id exists, so it never re-checks that. The pin
 * (`expected_revision_id`) must equal the node's CURRENT accepted head, else
 * a returned conflict -- and a node that already carries a terminal event
 * refuses a second one, append-only.
 */
export async function writeLifecycleEventFresh(
  writer: DatasetAdapter,
  core: OwnerCore,
  options: { clock: Clock },
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
  await writer.refresh(NODES);
  const node = await contextOne(
    writer,
    NODES,
    `workspace_name = ${quote(input.workspace_name)} AND id = ${quote(input.node_id)}`,
  );
  if (node === null) failPublication("invalid_reference", "/node_id");
  const encodedNode = encodeNodeRow(node);
  const headId = encodedNode.current_revision_id;
  if (typeof headId !== "string") failPublication("integrity_failure", "");
  // The pin is FORCED, not optional: old_revision_id is NOT NULL. A pin that
  // does not name the current head is an ordinary returned conflict.
  if (headId !== input.expected_revision_id) {
    return { outcome: "conflict", reason: "stale_pin", row: null };
  }

  // Append-only: a node that already carries a terminal event refuses a
  // second one. The head cannot have moved since (publishRevision refuses
  // new revisions once this row exists), so the pin above always still
  // agrees -- this is a SEPARATE business rule, not corruption.
  const priorEvent = await contextOne(
    writer,
    SUPERSEDE_LOG,
    `workspace_name = ${quote(input.workspace_name)} AND old_id = ${quote(input.node_id)}`,
  );
  if (priorEvent !== null) {
    return { outcome: "conflict", reason: "already_terminal", row: encodeSupersedeLogRow(priorEvent) };
  }

  await writer.refresh(NODE_REVISIONS);
  const revision = await contextOne(
    writer,
    NODE_REVISIONS,
    `workspace_name = ${quote(input.workspace_name)} AND id = ${quote(input.expected_revision_id)}` +
      ` AND node_id = ${quote(input.node_id)}`,
  );
  if (revision === null) failPublication("integrity_failure", "");
  const encodedRevision = encodeRevisionRow(revision);
  const oldTitle = encodedRevision.title as string;
  const oldType = deriveNodeType(encodedRevision);

  // Allocation under the gate + serial queue, NOT CAS: the same pattern as
  // the message id/seq allocator. `id` is int64, so the ceiling is guarded
  // exactly as there.
  const maxId = await selectedMaximum(writer, SUPERSEDE_LOG, "id", "true");
  const nextId = (maxId === null || maxId < 0n ? 0n : maxId) + 1n;
  if (nextId > INT64_CEILING) failPublication("integrity_failure", "");
  const idTaken = await writer.query(SUPERSEDE_LOG, `id = ${nextId.toString(10)}`, 2);
  if (idTaken.length !== 0) failPublication("integrity_failure", "");

  // ONLY a real new event samples the clock.
  const sampled = options.clock();
  if (typeof sampled !== "number" || !Number.isSafeInteger(sampled)) {
    failPublication("invalid_request", "");
  }
  const micros = BigInt(sampled) * 1000n;
  try {
    // Rendering is the range check: no second copy of the Gregorian grammar.
    microsToTimestamp(micros);
  } catch (error) {
    if (!(error instanceof PublicationError)) throw error;
    // The clock is operator configuration, not a caller field: ROOT.
    return failPublication("invalid_request", "");
  }

  const physical: Record<string, unknown> = {
    id: nextId,
    workspace_name: input.workspace_name,
    old_id: input.node_id,
    old_revision_id: input.expected_revision_id,
    old_title: oldTitle,
    old_type: oldType,
    // No origin anywhere in the schema for either *_source column.
    old_source: null,
    new_id: input.successor === null ? null : input.successor.new_id,
    new_revision_id: input.successor === null ? null : input.successor.new_revision_id,
    new_title: input.successor === null ? null : input.successor.new_title,
    new_source: null,
    reason: input.reason,
    peer_name: input.peer_name,
    superseded_at: micros,
    operation_id: input.operation_id,
    h_metadata: null,
  };
  const expected = encodeSupersedeLogRow(physical);

  const stored = await writeRow(
    SUPERSEDE_LOG,
    physical,
    async () => {
      const found = await contextOne(
        writer,
        SUPERSEDE_LOG,
        `workspace_name = ${quote(input.workspace_name)} AND operation_id = ${quote(input.operation_id)}`,
      );
      if (found === null) {
        core.poison();
        failPublication("recovery_required", "");
      }
      return encodeSupersedeLogRow(found);
    },
    expected,
    SUPERSEDE_LOG_FIELDS,
    false,
  );
  return { outcome: "accepted", row: stored };
}
