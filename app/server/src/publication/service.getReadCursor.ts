import { parseGetReadCursor } from "./read-cursor";
import { resolveCursorScope } from "./service.resolveCursorScope";
import { selectCursorRow } from "./service.selectCursorRow";
import { type DatasetAdapter } from "./service.types";

export async function getReadCursor(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
const request = parseGetReadCursor(requestBytes);
      await resolveCursorScope(reader, request);
      // Absent is null, never not_found: there is no cursor to have lost.
      const current = await selectCursorRow(reader, request);
      return current === null ? null : current.encoded;
}
