import { type EvidenceWriterBundle } from "../publication/service.types";
import { errorOutcome } from "./errorOutcome";
import { type Emit, type MigrationPlan } from "./plan.types";
import { requestBytes } from "./requestBytes";

const PAGE = 100;

/**
 * Read the migrated knowledge back through the kernel's OWN read methods --
 * `listNodes` to enumerate each workspace (keyset pages) and `getAcceptedHead`
 * for every node the worker published -- so "migrated" means "the service
 * can serve it", not "a row exists". The head must be the plan's first
 * revision with the legacy title and body.
 */
export async function readBackNodes(
  bundle: EvidenceWriterBundle,
  plan: MigrationPlan,
  published: Set<string>,
  emit: Emit,
): Promise<void> {
  const listed: Record<string, number> = {};
  const failed: Array<Record<string, unknown>> = [];
  let headsOk = 0;
  for (const workspace of plan.workspaces) {
    const ws = workspace.workspace_name;
    let count = 0;
    let after: string | null = null;
    try {
      for (;;) {
        const page = (await bundle.publication.listNodes(requestBytes({
          workspace_name: ws, after_id: after, limit: PAGE, include_total: false, type_term: null,
        }))) as { rows: unknown[]; next_after_id: string | null };
        count += page.rows.length;
        if (page.next_after_id === null) break;
        after = page.next_after_id;
      }
    } catch (error) {
      failed.push({ workspace: ws, step: "listNodes", ...errorOutcome(error) });
    }
    listed[ws] = count;

    for (const memory of workspace.memories) {
      if (!published.has(memory.legacy_id)) continue;
      try {
        const head = (await bundle.publication.getAcceptedHead(requestBytes({
          workspace_name: ws, node_id: memory.node_id,
        }))) as { revision: Record<string, unknown> } | null;
        const revision = head?.revision;
        const ok = revision !== undefined && revision.id === memory.revision_id
          && revision.title === memory.title && revision.body === memory.body;
        if (ok) headsOk += 1;
        else failed.push({ workspace: ws, legacy_id: memory.legacy_id, step: "getAcceptedHead", code: "head_mismatch" });
      } catch (error) {
        failed.push({ workspace: ws, legacy_id: memory.legacy_id, step: "getAcceptedHead", ...errorOutcome(error) });
      }
    }
  }
  emit({ kind: "readback", listed_nodes: listed, heads_ok: headsOk, heads_failed: failed });
}
