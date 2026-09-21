import { expectedSets } from "./service.expectedSets";

export function associationsFor(workspace: string, nodeId: string, head: string, selected: Record<string, unknown>) {
const sets = expectedSets(workspace, selected);
    return {
      workspace_name: workspace,
      node_id: nodeId,
      revision_id: selected.id as string,
      content_digest: selected.content_digest as string,
      snapshot_head_revision_id: head,
      is_snapshot_head: selected.id === head,
      terms: sets.terms,
      links: sets.links,
    };
}
