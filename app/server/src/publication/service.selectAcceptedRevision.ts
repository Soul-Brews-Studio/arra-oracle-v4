import { failPublication } from "./errors";
import { encodeNodeRow } from "./rows";
import { findNode } from "./service.findNode";
import { type Ancestry, type DatasetAdapter } from "./service.types";
import { walkAncestry } from "./service.walkAncestry";

/**
 * Resolve the accepted ancestry a request selects.
 *
 * `null` revision means the CAPTURED HEAD. An explicit revision that is not on
 * accepted ancestry returns null rather than a raw orphan: a row merely
 * existing in the table is not acceptance.
 */
export async function selectAcceptedRevision(
  adapter: DatasetAdapter,
  workspace: string,
  nodeId: string,
  revisionId: string | null,
): Promise<{ ancestry: Ancestry; head: string; selected: Record<string, unknown> } | null> {
  await adapter.refresh("nodes");
  const node = await findNode(adapter, workspace, nodeId);
  if (node === null) return null;
  const encodedNode = encodeNodeRow(node);
  const head = encodedNode.current_revision_id;
  if (typeof head !== "string") failPublication("integrity_failure", "");
  await adapter.refresh("node_revisions");
  const ancestry = await walkAncestry(adapter, workspace, nodeId, head);
  const wanted = revisionId ?? head;
  const selected = ancestry.encoded.find((row) => row.id === wanted);
  if (selected === undefined) return null;
  return { ancestry, head, selected };
}
