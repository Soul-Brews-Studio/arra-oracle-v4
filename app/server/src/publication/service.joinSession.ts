import { type ChatModelFn } from "./chat";
import { SESSION_PEER_FIELDS as SESSION_PEER_FIELDS_LOCAL, encodeSessionPeerRow, encodeSessionRow, parseJoinSession } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { PEERS, SESSIONS, SESSION_PEERS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { type Clock, type ContextRegistration, type DatasetAdapter, type OwnerCore } from "./service.types";
import { writeContextRow } from "./service.writeContextRow";

export function joinSession(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn }, requestBytes: Uint8Array): Promise<ContextRegistration> {
return mutateContextWrite(core, async () => {
        const request = parseJoinSession(requestBytes);
        await requireContextWorkspaceRow(writer, request.workspace_name);
        await writer.refresh(SESSIONS);
        await writer.refresh(PEERS);

        const session = await contextOne(
          writer,
          SESSIONS,
          `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
        );
        if (session === null) failPublication("invalid_reference", "/session_name");
        if (encodeSessionRow(session).is_active !== true) {
          failPublication("invalid_reference", "/session_name");
        }
        const peer = await contextOne(
          writer,
          PEERS,
          `${contextScope(request.workspace_name)} AND name = ${quote(request.peer_name)}`,
        );
        if (peer === null) failPublication("invalid_reference", "/peer_name");

        await writer.refresh(SESSION_PEERS);
        const triple =
          `${contextScope(request.workspace_name)} AND session_name = ${quote(request.session_name)}` +
          ` AND peer_name = ${quote(request.peer_name)}`;
        const existing = await contextOne(writer, SESSION_PEERS, triple);
        if (existing !== null) {
          const stored = encodeSessionPeerRow(existing);
          // A left membership is TERMINAL through this interface. Rejoin is a
          // separately reviewed lifecycle operation; rewriting left_at here
          // would erase history.
          if (stored.left_at !== null) return { outcome: "conflict", reason: "membership" };
          return { outcome: "already_satisfied", row: stored };
        }

        const joined = BigInt(options.clock()) * 1000n;
        const physical = {
          workspace_name: request.workspace_name,
          session_name: request.session_name,
          peer_name: request.peer_name,
          configuration: null,
          internal_metadata: null,
          joined_at: joined,
          left_at: null,
        };
        const stored = await writeContextRow(writer, core, 
          SESSION_PEERS,
          physical,
          async () => {
            const found = await contextOne(writer, SESSION_PEERS, triple);
            if (found === null) {
              core.poison();
              failPublication("recovery_required", "");
            }
            return encodeSessionPeerRow(found);
          },
          encodeSessionPeerRow(physical),
          SESSION_PEER_FIELDS_LOCAL,
          false,
        );
        return { outcome: "created", row: stored };
      });
}
