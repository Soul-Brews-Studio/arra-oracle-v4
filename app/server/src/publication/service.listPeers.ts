import { MAX_RESULT_WIRE_BYTES, PEER_FIELDS, encodePeerRow, parseListPeers, rowWireBytes } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { PEERS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

export async function listPeers(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<{ rows: Record<string, unknown>[]; next_after_name: string | null; total: string | null }> {
const request = parseListPeers(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(PEERS);

      const workspaceScope = contextScope(request.workspace_name);
      const scope =
        workspaceScope +
        (request.after_name === null ? "" : ` AND name > ${quote(request.after_name)}`);

      // KEYSET, never offset: limit+1 decides continuation in the SAME
      // query, no second fetch needed. `name` is UNIQUE per workspace (the
      // stored schema enforces it, not just convention here), so ascending
      // name order is a TOTAL order -- a safe keyset with no ties, so no row
      // is ever skipped or repeated as the table grows between pages.
      const selected = await reader.orderedProjection(
        PEERS,
        scope,
        PEER_FIELDS as unknown as string[],
        { column: "name", ascending: true },
        request.limit + 1,
      );

      const names: string[] = [];
      for (const row of selected) {
        const rowName = row.name;
        if (typeof rowName !== "string") failPublication("integrity_failure", "");
        // The LOOKAHEAD row is validated too, not just the emitted page: a
        // duplicate name straddling the limit would otherwise evade the
        // check and split silently across two pages. A duplicate here would
        // mean the uniqueness this keyset relies on has already failed.
        if (names.includes(rowName)) failPublication("integrity_failure", "");
        names.push(rowName);
      }

      const page = selected.slice(0, request.limit);
      const rows: Record<string, unknown>[] = [];
      // Brackets plus one comma per row: sum + n + 1.
      let budget = 1;
      for (const row of page) {
        const encoded = encodePeerRow(row);
        budget += rowWireBytes(encoded) + 1;
        // Cumulative wire budget. Over budget fails; it never truncates, which
        // would hand back a short page indistinguishable from a real one.
        if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
        rows.push(encoded);
      }

      const hasMore = names.length > request.limit;

      // OPT-IN only: counting the full predicate is a SECOND full scan with
      // no keyset to bound it, unlike the page fetch above. That cost is
      // fine for a sidebar total asked for on purpose; it would be wrong to
      // impose on every ordinary page fetch, so `total` stays null unless
      // the caller asks.
      let total: string | null = null;
      if (request.include_total) {
        const counted = await reader.count(PEERS, workspaceScope);
        if (!Number.isSafeInteger(counted) || counted < 0) failPublication("integrity_failure", "");
        total = counted.toString(10);
      }

      return {
        rows,
        next_after_name: hasMore && page.length > 0 ? names[page.length - 1]! : null,
        total,
      };
}
