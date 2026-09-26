import { SESSION_FIELDS, closedInternalMetadata, encodeSessionRow, parseCloseSession, readCloseRecord } from "./context";
import { PublicationError, failPublication } from "./errors";
import { microsToTimestamp } from "./rows";
import { quote } from "./storage";
import { SESSIONS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { requireCurrentMembership } from "./service.requireCurrentMembership";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";

export type CloseSessionOutcome =
  | { outcome: "closed" | "idempotent"; row: Record<string, unknown> }
  | { outcome: "conflict"; reason: "operation_digest" | "already_closed"; row: Record<string, unknown> };

/**
 * K9 `closeSession` (docs/overnight/V3-PARITY.md §5; DECISIONS.md R18 D7): a
 * ONE-WAY close. `is_active` goes true -> false and the close is recorded in
 * `sessions.internal_metadata.closed = {at, by_peer, operation_id, reason}`
 * -- no new column, no new table, and nothing ever sets it back (registration
 * never reactivates, context-ingestion-v1.md §3).
 *
 * Precedence: grammar (before the queue), workspace, session, stored
 * integrity, replay of THIS session's recorded operation_id, already closed,
 * the closing peer's CURRENT membership, clock, write, readback. As with
 * lifecycle events, an exact replay outranks every later state check and
 * samples no clock, so it stays idempotent after the peer has left.
 *
 * The write is one guarded update: the row must still be active and still
 * hold the metadata that was read. Anything but exactly one updated row, or a
 * readback that differs in any physical field, is ambiguity after an
 * attempted write: poison, `recovery_required`.
 */
export function closeSession(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null }, requestBytes: Uint8Array): Promise<CloseSessionOutcome> {
  // STATIC validation precedes owner work: a malformed request is never an owner event.
  const request = parseCloseSession(requestBytes);
  return mutateContextWrite(core, async () => {
    await requireContextWorkspaceRow(writer, request.workspace_name);
    await writer.refresh(SESSIONS);
    const identity = `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`;
    const found = await contextOne(writer, SESSIONS, identity);
    if (found === null) failPublication("invalid_reference", "/session_name");
    const current = encodeSessionRow(found);
    const stored = readCloseRecord(current.internal_metadata as string | null);
    // A close record on a session still active is a state no close produces.
    if (current.is_active === true && stored.closed !== null) failPublication("integrity_failure", "");

    if (stored.closed !== null && stored.closed.operation_id === request.operation_id) {
      const same = stored.closed.reason === request.reason && stored.closed.by_peer === request.peer_name;
      // Exact replay: the ORIGINAL row, no clock sample, no boundary, no write.
      return same
        ? { outcome: "idempotent" as const, row: current }
        : { outcome: "conflict" as const, reason: "operation_digest" as const, row: current };
    }
    // One way: a closed session is never closed twice, and its record is never rewritten.
    if (current.is_active !== true) return { outcome: "conflict" as const, reason: "already_closed" as const, row: current };
    if (request.peer_name !== null) {
      await requireCurrentMembership(writer, request.workspace_name, request.session_name, request.peer_name, "/peer_name");
    }

    const sampled = options.clock();
    if (typeof sampled !== "number" || !Number.isSafeInteger(sampled)) failPublication("invalid_request", "");
    let at: string;
    try {
      // Rendering is the range check; an unrenderable sample never reaches the store.
      at = microsToTimestamp(BigInt(sampled) * 1000n);
    } catch (error) {
      if (!(error instanceof PublicationError)) throw error;
      // The clock is operator configuration, not a caller field: ROOT.
      return failPublication("invalid_request", "");
    }

    // Build the complete target BEFORE anything is attempted.
    const metadata = closedInternalMetadata(stored.others, {
      at,
      by_peer: request.peer_name,
      operation_id: request.operation_id,
      reason: request.reason,
    });
    const expected: Record<string, unknown> = { ...current, is_active: false, internal_metadata: metadata };
    const before = current.internal_metadata === null ? "IS NULL" : `= ${quote(current.internal_metadata as string)}`;
    const row = `${identity} AND id = ${quote(current.id as string)}`;

    await core.contextBoundary("before_write", false);
    core.markAttemptedWrite();
    const { rowsUpdated } = await core.afterWrite(async () =>
      writer.updateWhere(SESSIONS, `${row} AND is_active = true AND internal_metadata ${before}`, {
        is_active: "false",
        internal_metadata: quote(metadata),
      }),
    );
    // An absent count maps to 0 and is not an acknowledgment: fail-stop.
    if (rowsUpdated !== 1) {
      core.poison();
      failPublication("recovery_required", "");
    }
    await core.contextBoundary("after_write", true);

    const closed = await core.afterWrite(async () => {
      await writer.refresh(SESSIONS);
      const again = await contextOne(writer, SESSIONS, row);
      if (again === null) {
        core.poison();
        failPublication("recovery_required", "");
      }
      const encoded = encodeSessionRow(again);
      // Every physical field, not a decode: decoding proves structure and
      // says nothing about whether the row holds what was asked for.
      for (const field of SESSION_FIELDS) {
        if (encoded[field] !== expected[field]) {
          core.poison();
          failPublication("recovery_required", "");
        }
      }
      return encoded;
    });
    await core.contextBoundary("after_readback", true);
    return { outcome: "closed" as const, row: closed };
  });
}
