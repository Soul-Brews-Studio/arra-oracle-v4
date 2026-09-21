import { quote } from "./storage";
import { encodeTraceRow, parseGetTrace } from "./trace";
import { TRACES } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

export async function getTrace(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
const request = parseGetTrace(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(TRACES);
      const row = await contextOne(
        reader,
        TRACES,
        `${contextScope(request.workspace_name)} AND id = ${quote(request.id)}`,
      );
      // Absent is null, NOT not_found: that code's fixed message is node-specific.
      return row === null ? null : encodeTraceRow(row);
}
