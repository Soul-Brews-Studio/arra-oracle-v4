import { type ChatModelFn } from "./chat";
import { PublicationError, failPublication } from "./errors";
import { READ_CURSOR_FIELDS, encodeReadCursorRow, parseAdvanceReadCursor } from "./read-cursor";
import { microsToTimestamp } from "./rows";
import { quote } from "./storage";
import { READ_CURSORS, cursorKey } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { resolveCursorScope } from "./service.resolveCursorScope";
import { selectCursorMessage } from "./service.selectCursorMessage";
import { selectCursorRow } from "./service.selectCursorRow";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";

export function advanceReadCursor(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn }, requestBytes: Uint8Array) {
// STATIC validation precedes owner work. Parsing inside the queued turn
      // would make a malformed request an owner event.
      const request = parseAdvanceReadCursor(requestBytes);
      return mutateContextWrite(core, async () => {
        await resolveCursorScope(writer, request);

        // Stored corruption is decided BEFORE any ordinary conflict: a corrupt
        // cursor must not be reported as a mere guard mismatch.
        const current = await selectCursorRow(writer, request);
        const desired = await selectCursorMessage(
          writer,
          request.workspace_name,
          request.session_name,
          request.last_read_message_id,
          { code: "invalid_reference", path: "/last_read_message_id" },
        );

        // 1. Already there: the retained row and its ORIGINAL timestamp, with
        //    no guard comparison, no clock sample and no mutation.
        if (current !== null && current.encoded.last_read_message_id === request.last_read_message_id) {
          return { outcome: "already_satisfied" as const, row: current.encoded };
        }

        // 2. Backward, by signed BigInt ordinal only. Never lexical, never a
        //    Number, never a timestamp, and never clamped at zero: retained
        //    negatives, gaps and values beyond 2^53 all order correctly.
        if (current !== null && current.seq !== null && desired.seq < current.seq) {
          return { outcome: "conflict" as const, reason: "backward" as const, row: current.encoded };
        }

        // 3. The guard names the exact prior state: absent, present-with-null,
        //    or present-with-pointer. An expected pointer is an old VALUE, so
        //    it is compared, never dereferenced.
        const guardMatches =
          request.expected === null
            ? current === null
            : current !== null &&
              current.encoded.last_read_message_id === request.expected.last_read_message_id;
        if (!guardMatches) {
          return {
            outcome: "conflict" as const,
            reason: "expected" as const,
            row: current === null ? null : current.encoded,
          };
        }

        // 4. ONLY a real creation or advance samples the clock.
        const sampled = options.clock();
        if (typeof sampled !== "number" || !Number.isSafeInteger(sampled)) {
          failPublication("invalid_request", "");
        }
        const micros = BigInt(sampled) * 1000n;
        let renderedAt: string;
        try {
          // Rendering is the range check: no second copy of the Gregorian
          // grammar, and an unrenderable sample never reaches the store.
          renderedAt = microsToTimestamp(micros);
        } catch (error) {
          if (!(error instanceof PublicationError)) throw error;
          // The clock is operator configuration, not a caller field: ROOT.
          return failPublication("invalid_request", "");
        }
        if (current !== null && micros < current.rawMicros) {
          // Raw MICROSECOND comparison. Equality is allowed; a regression
          // writes nothing at all, including no table version change.
          failPublication("invalid_request", "");
        }

        // 5. Build the complete target BEFORE anything is attempted, so no
        //    conversion can fail after the owner is marked.
        const target: Record<string, unknown> = {
          workspace_name: request.workspace_name,
          peer_name: request.peer_name,
          session_name: request.session_name,
          last_read_message_id: request.last_read_message_id,
          last_read_at: renderedAt,
        };
        const physical: Record<string, unknown> = {
          workspace_name: request.workspace_name,
          peer_name: request.peer_name,
          session_name: request.session_name,
          last_read_message_id: request.last_read_message_id,
          // Arrow needs BigInt microseconds; a JS Number silently corrupts.
          last_read_at: micros,
        };
        const key = cursorKey(request.workspace_name, request.peer_name, request.session_name);

        await core.contextBoundary("before_write", false);
        core.markAttemptedWrite();
        if (current === null) {
          await core.afterWrite(async () => {
            await writer.append(READ_CURSORS, [physical]);
          });
        } else {
          const { rowsUpdated } = await core.afterWrite(async () =>
            writer.updateWhere(
              READ_CURSORS,
              // The logical key AND the expected previous pointer. IS NULL is
              // the only spelling that matches a retained null pointer.
              `${key} AND last_read_message_id ${
                current.encoded.last_read_message_id === null
                  ? "IS NULL"
                  : `= ${quote(current.encoded.last_read_message_id as string)}`
              }`,
              {
                last_read_message_id: quote(request.last_read_message_id),
                last_read_at: `CAST(${micros.toString(10)} AS TIMESTAMP(6))`,
              },
            ),
          );
          // An absent or non-number count is mapped to 0 by the adapter and is
          // NOT a reliable acknowledgment. Anything but exactly one is
          // ambiguous after a write attempt: fail-stop, never an expected
          // conflict, never success.
          if (rowsUpdated !== 1) {
            core.poison();
            failPublication("recovery_required", "");
          }
        }
        await core.contextBoundary("after_write", true);

        const stored = await core.afterWrite(async () => {
          await writer.refresh(READ_CURSORS);
          // A duplicate logical key here is corruption and propagates as
          // integrity_failure; afterWrite poisons on the way out.
          const row = await contextOne(writer, READ_CURSORS, key);
          if (row === null) {
            core.poison();
            failPublication("recovery_required", "");
          }
          const encoded = encodeReadCursorRow(row);
          for (const field of READ_CURSOR_FIELDS) {
            // Every physical field, not a count and not a decode: decoding
            // proves structure and says nothing about what was asked for.
            if (encoded[field] !== target[field]) {
              core.poison();
              failPublication("recovery_required", "");
            }
          }
          // The chosen identity must STILL be the one that was selected.
          //
          // AFTER a write the classes differ from before it: a target that has
          // gone missing, or a well-formed row that is no longer the one
          // chosen, is ambiguity -- recovery_required. A duplicate or
          // malformed row is corruption and keeps integrity_failure, which
          // selectCursorMessage raises from within and afterWrite poisons on
          // the way out.
          const again = await selectCursorMessage(
            writer,
            request.workspace_name,
            request.session_name,
            request.last_read_message_id,
            { code: "recovery_required", path: "" },
          );
          if (again.seq !== desired.seq) {
            core.poison();
            failPublication("recovery_required", "");
          }
          // FULL encoded identity, not public_id and seq alone: a different
          // legacy id under the same public_id and ordinal would otherwise
          // pass the readback unnoticed.
          for (const field of Object.keys(desired.encoded)) {
            if (again.encoded[field] !== desired.encoded[field]) {
              core.poison();
              failPublication("recovery_required", "");
            }
          }
          return encoded;
        });
        await core.contextBoundary("after_readback", true);

        return {
          outcome: current === null ? ("created" as const) : ("advanced" as const),
          row: stored,
        };
      });
}
