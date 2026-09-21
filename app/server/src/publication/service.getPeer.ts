import { encodePeerRow, parseGetPeer } from "./context";
import { quote } from "./storage";
import { PEERS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

export async function getPeer(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
const request = parseGetPeer(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(PEERS);
      const row = await contextOne(
        reader,
        PEERS,
        `${contextScope(request.workspace_name)} AND name = ${quote(request.peer_name)}`,
      );
      // Absent is null, NOT not_found: that code's fixed message is node-specific.
      return row === null ? null : encodePeerRow(row);
}
