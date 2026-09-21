import { prepareNewMessage } from "../contracts/source-ingestion-v1";
import { type ChatModelFn } from "./chat";
import { MAX_RESULT_WIRE_BYTES, MESSAGE_FIELDS as MESSAGE_FIELDS_LOCAL, encodeMessageRow, encodeSessionRow, parseAppendMessages, rowWireBytes } from "./context";
import { failPublication, isContractError } from "./errors";
import { timestampToMicros } from "./rows";
import { quote } from "./storage";
import { assertReplayDestination } from "./service.assertReplayDestination";
import { assertReplyChain } from "./service.assertReplyChain";
import { INT64_CEILING, MESSAGES, SESSIONS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { requireCurrentMembership } from "./service.requireCurrentMembership";
import { safeErrorEnvelope } from "./service.safeErrorEnvelope";
import { selectedMaximum } from "./service.selectedMaximum";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";
import { writeContextRow } from "./service.writeContextRow";

export async function appendMessages(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn }, requestBytes: Uint8Array) {
const request = parseAppendMessages(requestBytes);
      const accepted: Array<{ index: number; outcome: "accepted" | "idempotent"; row: Record<string, unknown> }> = [];
      // Brackets, then one comma per row: sum + n + 1, not sum + n.
      let budget = 1;
      // Did the batch actually ENTER the queued turn? A refusal that happens
      // before admission -- closing, poisoned, owner unavailable -- must throw,
      // because no item was ever entered and there is no prefix to report.
      let admitted = false;

      try {
        const conflict = await core.serial(async () => {
          admitted = true;
          await requireContextWorkspaceRow(writer, request.workspace_name);
          await writer.refresh(SESSIONS);
          const session = await contextOne(
            writer,
            SESSIONS,
            `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
          );
          if (session === null) failPublication("invalid_reference", "/session_name");
          if (encodeSessionRow(session).is_active !== true) {
            failPublication("invalid_reference", "/session_name");
          }

          // Maxima are read ONCE, when the first NEW item needs them, then
          // incremented privately under the held queue. Replays consume none.
          let nextId: bigint | null = null;
          let nextSeq: bigint | null = null;
          let wroteAny = false;

          for (const [index, item] of request.items.entries()) {
            const at = (...rest: string[]) => `/items/${index}${rest.map((r) => `/${r}`).join("")}`;

            await writer.refresh(MESSAGES);
            const byPublicId = await contextOne(
              writer,
              MESSAGES,
              `${contextScope(request.workspace_name)} AND public_id = ${quote(item.public_id)}`,
            );

            // ---- validate mode/digest WITHOUT sampling the clock. A sentinel
            // intake is used because the seven-field digest excludes intake,
            // so both passes agree. Its derived times are discarded.
            let validated: Record<string, unknown>;
            try {
              validated = prepareNewMessage(JSON.stringify({
                context: {
                  workspace_name: request.workspace_name,
                  session_name: request.session_name,
                  intake_at: "1970-01-01T00:00:00.000Z",
                  source_namespace: options.sourceNamespace,
                },
                message: item.message,
                source: item.source,
              }));
            } catch (error) {
              if (isContractError(error)) throw error;
              return failPublication("invalid_request", at());
            }

            const sourceMessageId = validated.source_message_id as string | null;
            const digest = validated.source_payload_digest as string | null;

            // ---- REPLAY resolution. Sourced is anchored to its source tuple.
            let existing: Record<string, unknown> | null = null;
            if (sourceMessageId !== null && options.sourceNamespace !== null) {
              existing = await contextOne(
                writer,
                MESSAGES,
                `${contextScope(request.workspace_name)} AND source_namespace = ${quote(options.sourceNamespace)}` +
                  ` AND source_message_id = ${quote(sourceMessageId)}`,
              );
              if (existing !== null) {
                const stored = encodeMessageRow(existing);
                await requireCurrentMembership(
                  writer,
                  request.workspace_name,
                  request.session_name,
                  stored.peer_name as string,
                  at("message", "peer_name"),
                );
                // Destination FIRST, then proposed-ID collision, THEN payload.
                // The accepted wrapper owns that ordering and the exact error.
                assertReplayDestination(
                  request.workspace_name,
                  request.session_name,
                  stored,
                  `/items/${index}`,
                );
                // A different UNOCCUPIED proposal is ignored and the original
                // id is returned; a proposal naming ANOTHER row conflicts.
                if (byPublicId !== null && byPublicId.public_id !== stored.public_id) {
                  return { index, conflict: "public_id" as const };
                }
                if (stored.source_payload_digest !== digest) {
                  return { index, conflict: "source_payload" as const };
                }
                budget += rowWireBytes(stored) + 1;
                // A response over budget is a LIMIT, not a conflict: reporting
                // public_id here would blame the caller's identifier for a size
                // problem. It stops at this index without a new write.
                if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
                accepted.push({ index, outcome: "idempotent", row: stored });
                continue;
              }
            }

            // Source ABSENT but the proposed id is occupied: that row cannot be
            // adopted into a sourced identity, so it conflicts before any local
            // field comparison runs.
            if (sourceMessageId !== null && existing === null && byPublicId !== null) {
              return { index, conflict: "public_id" as const };
            }

            if (byPublicId !== null) {
              const stored = encodeMessageRow(byPublicId);
              await requireCurrentMembership(
                writer,
                request.workspace_name,
                request.session_name,
                stored.peer_name as string,
                at("message", "peer_name"),
              );
              // Local wrong-destination has the SAME semantics as sourced, so
              // it goes through the same wrapper and carries the same envelope.
              assertReplayDestination(
                request.workspace_name,
                request.session_name,
                stored,
                `/items/${index}`,
              );
              // A local request cannot adopt a sourced row, nor the reverse.
              const storedIsSourced = stored.source_message_id !== null;
              const requestIsSourced = sourceMessageId !== null;
              if (storedIsSourced !== requestIsSourced) return { index, conflict: "public_id" as const };
              if (
                stored.peer_name !== validated.peer_name ||
                stored.content !== validated.content ||
                stored.role !== validated.role ||
                stored.in_reply_to !== validated.in_reply_to
              ) {
                return { index, conflict: "public_id" as const };
              }
              budget += rowWireBytes(stored) + 1;
              if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
              accepted.push({ index, outcome: "idempotent", row: stored });
              continue;
            }

            // ---- Refs and policy. These run for REPLAY as well as for a new
            // item: a replay after the peer left must be refused, and stored
            // identity integrity is not excused by "we saw this before".
            await requireCurrentMembership(
              writer,
              request.workspace_name,
              request.session_name,
              validated.peer_name as string,
              at("message", "peer_name"),
            );

            const replyTo = validated.in_reply_to as string | null;
            if (replyTo !== null) {
              if (replyTo === item.public_id) failPublication("invalid_request", at("message", "in_reply_to"));
              const parent = await contextOne(
                writer,
                MESSAGES,
                `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)}` +
                  ` AND public_id = ${quote(replyTo)}`,
              );
              if (parent === null) failPublication("invalid_reference", at("message", "in_reply_to"));
              await assertReplyChain(writer, request.workspace_name, request.session_name, parent);
            }

            if (nextId === null) {
              const maxId = await selectedMaximum(writer, MESSAGES, "id", "true");
              nextId = (maxId === null || maxId < 0n ? 0n : maxId) + 1n;
              const maxSeq = await selectedMaximum(
                writer,
                MESSAGES,
                "seq_in_session",
                `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)}`,
              );
              nextSeq = (maxSeq === null || maxSeq < 0n ? 0n : maxSeq) + 1n;
            }
            if (nextId! > INT64_CEILING || nextSeq! > INT64_CEILING) {
              failPublication("integrity_failure", "");
            }

            // BOTH proposed keys must be vacant before the append. Checking
            // only the global id would let a session sequence collide.
            const idTaken = await writer.query(MESSAGES, `id = ${nextId!.toString(10)}`, 2);
            if (idTaken.length !== 0) failPublication("integrity_failure", "");
            const seqTaken = await writer.query(
              MESSAGES,
              `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)}` +
                ` AND seq_in_session = ${nextSeq!.toString(10)}`,
              2,
            );
            if (seqTaken.length !== 0) failPublication("integrity_failure", "");

            const intake = new Date(options.clock()).toISOString();
            let row: Record<string, unknown>;
            try {
              row = prepareNewMessage(JSON.stringify({
                context: {
                  workspace_name: request.workspace_name,
                  session_name: request.session_name,
                  intake_at: intake,
                  source_namespace: options.sourceNamespace,
                },
                message: item.message,
                source: item.source,
              }));
            } catch (error) {
              if (isContractError(error)) throw error;
              return failPublication("invalid_request", at());
            }

            const physical = {
              id: nextId!,
              public_id: item.public_id,
              workspace_name: request.workspace_name,
              session_name: request.session_name,
              peer_name: row.peer_name,
              content: row.content,
              // 0 means NOT MEASURED, not a tokenizer result.
              token_count: 0n,
              seq_in_session: nextSeq!,
              h_metadata: null,
              internal_metadata: null,
              created_at: timestampToMicros(row.created_at),
              role: row.role,
              in_reply_to: row.in_reply_to,
              read: null,
              read_at: null,
              source_namespace: row.source_namespace,
              source_message_id: row.source_message_id,
              source_payload_digest: row.source_payload_digest,
              source_created_at:
                row.source_created_at === null ? null : timestampToMicros(row.source_created_at as string),
              ingested_at: timestampToMicros(row.ingested_at),
            };
            const expected = encodeMessageRow(physical);

            const stored = await writeContextRow(writer, core, 
              MESSAGES,
              physical,
              async () => {
                // FOUR independent identities must each select exactly one row,
                // and it must be the SAME row. A public-id lookup alone would
                // miss a duplicated physical id or a colliding sequence.
                const scope = contextScope(request.workspace_name);
                const lookups: string[] = [
                  `${scope} AND public_id = ${quote(item.public_id)}`,
                  `${scope} AND session_name = ${quote(request.session_name)} AND seq_in_session = ${nextSeq!.toString(10)}`,
                  `id = ${nextId!.toString(10)}`,
                ];
                if (row.source_message_id !== null && row.source_namespace !== null) {
                  lookups.push(
                    `${scope} AND source_namespace = ${quote(row.source_namespace as string)}` +
                      ` AND source_message_id = ${quote(row.source_message_id as string)}`,
                  );
                }
                let selected: Record<string, unknown> | null = null;
                for (const predicate of lookups) {
                  const found = await contextOne(writer, MESSAGES, predicate);
                  if (found === null) {
                    core.poison();
                    failPublication("recovery_required", "");
                  }
                  const encoded = encodeMessageRow(found);
                  if (selected !== null && encoded.public_id !== selected.public_id) {
                    core.poison();
                    failPublication("recovery_required", "");
                  }
                  selected = encoded;
                }
                return selected!;
              },
              expected,
              MESSAGE_FIELDS_LOCAL,
              wroteAny,
            );
            wroteAny = true;
            nextId! += 1n;
            nextSeq! += 1n;
            budget += rowWireBytes(stored) + 1;
            if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
            accepted.push({ index, outcome: "accepted", row: stored });
          }
          return null;
        });

        if (conflict !== null) {
          return { outcome: "stopped" as const, results: accepted, stop: conflict };
        }
        return { outcome: "complete" as const, results: accepted, stop: null };
      } catch (error) {
        // Pre-admission refusal: rethrow. Converting it to a stopped result
        // would invent an item-level failure for a request that never entered.
        if (!admitted) throw error;
        // The serial boundary has ALREADY classified and poisoned as needed.
        // This only serializes the outcome.
        return {
          outcome: "stopped" as const,
          results: accepted,
          stop: { index: accepted.length, error: safeErrorEnvelope(error) },
        };
      }
}
