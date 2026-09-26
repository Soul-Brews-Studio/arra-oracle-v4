import { MAX_RESULT_WIRE_BYTES, type RequestAuthority, encodeMessageRow, parseGetMessage, requireMessageReadAuthority, rowWireBytes } from "./context";
import { PublicationError, failPublication } from "./errors";
import { quote } from "./storage";
import { MESSAGES } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireCurrentMembership } from "./service.requireCurrentMembership";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/**
 * #87 / R3 (docs/overnight/DECISIONS.md): membership is a read boundary here.
 * With no requester, only the audit:read operator view in `authority` may read
 * (decided before any storage). A named `requester_peer_name` must hold CURRENT
 * membership of the message's OWN session, via the same
 * `requireCurrentMembership` getContext applies.
 *
 * A requester who is not a current member -- a stranger, a departed member or
 * a peer that does not exist -- reads null, exactly as for an absent id. A
 * refusal here would confirm that the id exists in some session the caller
 * cannot see (authorization-v1.md §3: missing and inaccessible references must
 * not expose existence). For the same reason membership is decided on the
 * stored row's raw `session_name` BEFORE the row's own integrity check: a
 * corrupt message is reported to whoever may read it, and a non-member still
 * reads null. Only a row whose `session_name` is not even a string reaches
 * the integrity check first, because no membership can be decided for it.
 */
export async function getMessage(reader: DatasetAdapter, requestBytes: Uint8Array, authority: RequestAuthority): Promise<Record<string, unknown> | null> {
const request = parseGetMessage(requestBytes);
      requireMessageReadAuthority(request.requester_peer_name, authority);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(MESSAGES);
      const row = await contextOne(
        reader,
        MESSAGES,
        `${contextScope(request.workspace_name)} AND public_id = ${quote(request.public_id)}`,
      );
      if (row === null) return null;
      if (request.requester_peer_name !== null) {
        const session = typeof row.session_name === "string" ? row.session_name : encodeMessageRow(row).session_name;
        try {
          await requireCurrentMembership(
            reader,
            request.workspace_name,
            session as string,
            request.requester_peer_name,
            "/requester_peer_name",
          );
        } catch (error) {
          if (!(error instanceof PublicationError) || error.code !== "invalid_reference") throw error;
          return null;
        }
      }
      const encoded = encodeMessageRow(row);
      // A single row over the response budget is refused rather than truncated.
      if (rowWireBytes(encoded) > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
      return encoded;
}
