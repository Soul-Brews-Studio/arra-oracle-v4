import { failPublication } from "./errors";
import { quote } from "./storage";
import { encodeTraceHitRow, parseListTraceHits } from "./trace";
import { TRACES, TRACE_HITS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

export async function listTraceHits(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<{ rows: Record<string, unknown>[]; next_after_position: string | null }> {
const request = parseListTraceHits(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(TRACES);
      const trace = await contextOne(
        reader,
        TRACES,
        `${contextScope(request.workspace_name)} AND id = ${quote(request.trace_id)}`,
      );
      if (trace === null) failPublication("invalid_reference", "/trace_id");

      await reader.refresh(TRACE_HITS);
      const after = request.after_position === null ? null : BigInt(request.after_position);
      const scope =
        `${contextScope(request.workspace_name)} AND trace_id = ${quote(request.trace_id)}` +
        (after === null ? "" : ` AND position > ${after.toString(10)}`);

      // KEYSET, never offset: limit+1 detects continuation without paging by
      // position, which would skip or repeat rows as the table grows.
      const selected = await reader.orderedProjection(
        TRACE_HITS,
        scope,
        ["position"],
        { column: "position", ascending: true },
        request.limit + 1,
      );

      // TR-3: `position` is contractually contiguous 0..n-1 per trace
      // (trace.ts). Enforced here against the KEYSET cursor itself -- the
      // first position seen must be exactly one past `after` (0 when
      // `after` is absent), and every following one must be its immediate
      // successor. A gap, a duplicate or an out-of-order value is stored
      // corruption, never a caller mismatch: integrity_failure at ROOT.
      const positions: bigint[] = [];
      let expectedNext = after === null ? 0n : after + 1n;
      for (const row of selected) {
        const position = row.position;
        if (typeof position !== "bigint") failPublication("integrity_failure", "");
        if (position !== expectedNext) failPublication("integrity_failure", "");
        positions.push(position);
        expectedNext = position + 1n;
      }

      const page = positions.slice(0, request.limit);
      const rows: Record<string, unknown>[] = [];
      for (const position of page) {
        const row = await contextOne(
          reader,
          TRACE_HITS,
          `${contextScope(request.workspace_name)} AND trace_id = ${quote(request.trace_id)} AND position = ${position.toString(10)}`,
        );
        if (row === null) failPublication("integrity_failure", "");
        rows.push(encodeTraceHitRow(row));
      }

      const hasMore = positions.length > request.limit;
      return {
        rows,
        next_after_position: hasMore && page.length > 0 ? page[page.length - 1]!.toString(10) : null,
      };
}
