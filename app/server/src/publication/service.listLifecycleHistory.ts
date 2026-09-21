import { failPublication } from "./errors";
import { encodeSupersedeLogRow, parseListLifecycleHistory } from "./lifecycle";
import { quote } from "./storage";
import { NODES, SUPERSEDE_LOG } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

export async function listLifecycleHistory(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<{ rows: Record<string, unknown>[]; next_after_event_id: string | null }> {
const request = parseListLifecycleHistory(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(NODES);
      const node = await contextOne(
        reader,
        NODES,
        `${contextScope(request.workspace_name)} AND id = ${quote(request.node_id)}`,
      );
      if (node === null) failPublication("invalid_reference", "/node_id");

      await reader.refresh(SUPERSEDE_LOG);
      const after = request.after_event_id === null ? null : BigInt(request.after_event_id);
      const scope =
        `${contextScope(request.workspace_name)} AND old_id = ${quote(request.node_id)}` +
        (after === null ? "" : ` AND id > ${after.toString(10)}`);

      const selected = await reader.orderedProjection(
        SUPERSEDE_LOG,
        scope,
        ["id"],
        { column: "id", ascending: true },
        request.limit + 1,
      );

      const keys: bigint[] = [];
      for (const row of selected) {
        const id = row.id;
        if (typeof id !== "bigint") failPublication("integrity_failure", "");
        if (keys.some((k) => k === id)) failPublication("integrity_failure", "");
        keys.push(id);
      }

      const page = keys.slice(0, request.limit);
      const rows: Record<string, unknown>[] = [];
      for (const id of page) {
        const row = await contextOne(
          reader,
          SUPERSEDE_LOG,
          `${contextScope(request.workspace_name)} AND old_id = ${quote(request.node_id)} AND id = ${id.toString(10)}`,
        );
        if (row === null) failPublication("integrity_failure", "");
        rows.push(encodeSupersedeLogRow(row));
      }

      const hasMore = keys.length > request.limit;
      return {
        rows,
        next_after_event_id: hasMore && page.length > 0 ? page[page.length - 1]!.toString(10) : null,
      };
}
