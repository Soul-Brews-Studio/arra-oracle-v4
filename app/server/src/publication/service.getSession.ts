import { encodeSessionRow, parseGetSession } from "./context";
import { quote } from "./storage";
import { SESSIONS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

export async function getSession(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
const request = parseGetSession(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(SESSIONS);
      const row = await contextOne(
        reader,
        SESSIONS,
        `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
      );
      // Retired status does not erase readable history, so inactive is returned.
      return row === null ? null : encodeSessionRow(row);
}
