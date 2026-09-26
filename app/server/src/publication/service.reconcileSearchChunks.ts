import { type ChatModelFn } from "./chat";
import { failPublication } from "./errors";
import { MAX_RECONCILE_REVISIONS, parseReconcileSearch } from "./search-chunk";
import { quote } from "./storage";
import { SEARCH_CHUNKS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { terminalEventsFor } from "./service.terminalEventsFor";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { selectAcceptedRevision } from "./service.selectAcceptedRevision";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";

export async function reconcileSearchChunks(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn }, requestBytes: Uint8Array): Promise<{
      visited: number;
      missing: number;
      missing_revisions: { node_id: string; revision_id: string }[];
      stale: number;
      exhausted: boolean;
      /** #29 slice B (overnight R7): retired or superseded nodes visited on
       *  this page, counted SEPARATELY from `missing` -- DESIGN.md:1119's
       *  "stale vectors never present superseded content as current truth"
       *  means a terminal node's absent chunks are not a gap to backfill,
       *  they are correctly not indexed. Never queued via `missing_revisions`. */
      ineligible: number;
    }> {
const request = parseReconcileSearch(requestBytes);
      await requireContextWorkspaceRow(writer, request.workspace_name);
      await writer.refresh("nodes");
      const fetched = await writer.orderedProjection(
        "nodes",
        contextScope(request.workspace_name),
        ["id"],
        { column: "id", ascending: true },
        request.limit + 1,
      );
      const visited = fetched.slice(0, request.limit);
      // Defensive, not reachable through the grammar today: `request.limit`
      // is already capped at MAX_RECONCILE_REVISIONS by parseReconcileSearch.
      // Kept as the documented bounded exception's own hard stop, in case
      // that cap is ever loosened without this one moving too.
      if (visited.length > MAX_RECONCILE_REVISIONS) failPublication("limit_exceeded", "");

      await writer.refresh("node_revisions");
      await writer.refresh(SEARCH_CHUNKS);

      const visitedIds = visited.map((row) => {
        const nodeId = row.id;
        if (typeof nodeId !== "string") failPublication("integrity_failure", "");
        return nodeId;
      });
      // ONE `supersede_log` query for the whole visited page, not one per
      // node (same batching rule as `listNodes`, analysis-29.json fix plan
      // B1/B5).
      const terminal = await terminalEventsFor(writer, request.workspace_name, visitedIds);

      let missing = 0;
      let stale = 0;
      let ineligible = 0;
      const missingRevisions: { node_id: string; revision_id: string }[] = [];
      for (const row of visited) {
        const nodeId = row.id;
        if (typeof nodeId !== "string") failPublication("integrity_failure", "");
        if (terminal.has(nodeId)) {
          ineligible += 1;
          continue;
        }
        const resolved = await selectAcceptedRevision(writer, request.workspace_name, nodeId, null);
        // Every node reached here was just selected FROM the nodes table, so
        // an unresolvable head is stored corruption, not a caller mistake.
        if (resolved === null) failPublication("integrity_failure", "");
        const revisionId = resolved.head;
        const present = await writer.query(
          SEARCH_CHUNKS,
          `${contextScope(request.workspace_name)} AND revision_id = ${quote(revisionId)}`,
          1,
        );
        if (present.length === 0) {
          missing += 1;
          missingRevisions.push({ node_id: nodeId, revision_id: revisionId });
          continue;
        }
        // STALE: chunk rows survive under this node for a revision that is no
        // longer the accepted head. Never deleted here -- this method only
        // reports, it does not reclaim.
        const staleRows = await writer.query(
          SEARCH_CHUNKS,
          `${contextScope(request.workspace_name)} AND node_id = ${quote(nodeId)} AND revision_id != ${quote(revisionId)}`,
          1,
        );
        if (staleRows.length > 0) stale += 1;
      }

      return {
        visited: visited.length,
        missing,
        missing_revisions: missingRevisions,
        stale,
        exhausted: fetched.length <= request.limit,
        ineligible,
      };
}
