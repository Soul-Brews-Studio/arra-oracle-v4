import { PublicationError, failPublication } from "./errors";
import { SUPERSEDE_LOG_FIELDS, encodeSupersedeLogRow } from "./lifecycle";
import { encodeNodeRow, encodeRevisionRow, microsToTimestamp } from "./rows";
import { quote } from "./storage";
import { INT64_CEILING, NODES, NODE_REVISIONS, PEERS, SUPERSEDE_LOG } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { deriveNodeType } from "./service.deriveNodeType";
import { terminalEventsFor } from "./service.terminalEventsFor";
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
 *
 * A non-null `peer_name` is a reference like any other peer field: it must be
 * exactly one `peers` row in THIS workspace, else `invalid_reference` at
 * `/peer_name` (lifecycle-v1 amendment 2026-09-26, #10). It is checked here,
 * on the fresh path only, so an exact replay of an event accepted before the
 * rule -- or of one whose peer was later renamed away -- stays idempotent.
 *
 * For `supersedeNode`, `input.successor`'s OWN terminal-state check (#29
 * slice B, overnight R7) runs immediately after the peer check below --
 * AFTER both of THIS request's own references (`/node_id`, `/peer_name`)
 * have resolved, so a caller naming a nonexistent node or peer is told so
 * rather than handed a `successor_terminal` conflict to retry into (see
 * lifecycle-v1.md's amendment, and the fix-round note recording why this
 * moved out of `service.supersedeNode.ts`). It still runs before the
 * pin/already-terminal checks, matching the original "checked once the
 * successor reference itself has resolved, after classification already
 * ran" ordering.
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
  // Request references resolve before any state is classified, as supersede's
  // successor does: a caller naming a peer that does not exist here is told
  // so, not handed a stale_pin/already_terminal conflict to retry into it.
  if (input.peer_name !== null) {
    await writer.refresh(PEERS);
    const peer = await contextOne(
      writer,
      PEERS,
      `workspace_name = ${quote(input.workspace_name)} AND name = ${quote(input.peer_name)}`,
    );
    if (peer === null) failPublication("invalid_reference", "/peer_name");
  }

  // #29 slice B (overnight R7): superseding INTO a successor that already
  // carries its own terminal event (retired, or itself already superseded)
  // is refused. Moved here, AFTER both of THIS request's own references
  // resolve, so a bad `/node_id` or `/peer_name` is told so rather than
  // handed a stale `successor_terminal` conflict to retry into (fix round:
  // the earlier placement in `service.supersedeNode.ts`, before this
  // function ran at all, broke that precedence -- see lifecycle-v1.md's
  // amendment). `retireNode` passes `successor: null`, so this never runs
  // for it.
  if (input.successor !== null) {
    const successorTerminal = (
      await terminalEventsFor(writer, input.workspace_name, [input.successor.new_id])
    ).get(input.successor.new_id);
    if (successorTerminal !== undefined) {
      return { outcome: "conflict", reason: "successor_terminal", row: null };
    }
  }

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
