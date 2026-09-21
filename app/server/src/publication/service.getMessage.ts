import { MAX_RESULT_WIRE_BYTES, encodeMessageRow, parseGetMessage, rowWireBytes } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { MESSAGES } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

export async function getMessage(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
const request = parseGetMessage(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(MESSAGES);
      const row = await contextOne(
        reader,
        MESSAGES,
        `${contextScope(request.workspace_name)} AND public_id = ${quote(request.public_id)}`,
      );
      if (row === null) return null;
      const encoded = encodeMessageRow(row);
      // A single row over the response budget is refused rather than truncated.
      if (rowWireBytes(encoded) > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
      return encoded;
}
