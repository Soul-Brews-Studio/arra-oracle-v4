import { rowWireBytes } from "./context";
import { failPublication } from "./errors";
import { MAX_RESULT_WIRE_BYTES as MAX_SESSION_LINK_WIRE_BYTES, SESSION_LINK_FIELDS, encodeSessionLinkRow, parseListSessionLinks } from "./session-link";
import { quote } from "./storage";
import { SESSIONS, SESSION_LINKS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

export async function listSessionLinks(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<{ rows: Record<string, unknown>[]; next_cursor: string | null }> {
const request = parseListSessionLinks(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(SESSIONS);
      const session = await contextOne(
        reader,
        SESSIONS,
        `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
      );
      if (session === null) failPublication("invalid_reference", "/session_name");

      await reader.refresh(SESSION_LINKS);
      const column = request.direction === "from" ? "from_session_name" : "to_session_name";
      const scope =
        `${contextScope(request.workspace_name)} AND ${column} = ${quote(request.session_name)}` +
        (request.cursor === null ? "" : ` AND id > ${quote(request.cursor)}`);

      // KEYSET, never offset: limit+1 detects continuation and the lookahead
      // row is validated for a duplicate id straddling the page edge.
      const selected = await reader.orderedProjection(
        SESSION_LINKS,
        scope,
        SESSION_LINK_FIELDS as unknown as string[],
        { column: "id", ascending: true },
        request.limit + 1,
      );

      const ids: string[] = [];
      for (const row of selected) {
        const encoded = encodeSessionLinkRow(row);
        const id = encoded.id as string;
        if (ids.includes(id)) failPublication("integrity_failure", "");
        ids.push(id);
      }

      const page = ids.slice(0, request.limit);
      const rows: Record<string, unknown>[] = [];
      // Brackets plus one comma per row: sum + n + 1.
      let budget = 1;
      for (const id of page) {
        const row = await contextOne(
          reader,
          SESSION_LINKS,
          `${contextScope(request.workspace_name)} AND id = ${quote(id)}`,
        );
        if (row === null) failPublication("integrity_failure", "");
        const encoded = encodeSessionLinkRow(row);
        budget += rowWireBytes(encoded) + 1;
        if (budget > MAX_SESSION_LINK_WIRE_BYTES) failPublication("limit_exceeded", "");
        rows.push(encoded);
      }

      const hasMore = ids.length > request.limit;
      return {
        rows,
        next_cursor: hasMore && page.length > 0 ? page[page.length - 1]! : null,
      };
}
