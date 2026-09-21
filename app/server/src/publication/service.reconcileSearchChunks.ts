import { type ChatModelFn } from "./chat";
import { failPublication } from "./errors";
import { MAX_RECONCILE_REVISIONS, parseReconcileSearch } from "./search-chunk";
import { quote } from "./storage";
import { SEARCH_CHUNKS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { selectAcceptedRevision } from "./service.selectAcceptedRevision";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";

export async function reconcileSearchChunks(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn }, requestBytes: Uint8Array): Promise<{
      visited: number;
      missing: number;
      missing_revisions: { node_id: string; revision_id: string }[];
      stale: number;
      exhausted: boolean;
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
      let missing = 0;
      let stale = 0;
      const missingRevisions: { node_id: string; revision_id: string }[] = [];
      for (const row of visited) {
        const nodeId = row.id;
        if (typeof nodeId !== "string") failPublication("integrity_failure", "");
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
      };
}
