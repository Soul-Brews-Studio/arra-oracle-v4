import { failPublication } from "./errors";
import { encodeNodeRow } from "./rows";
import { findNode } from "./service.findNode";
import { type DatasetAdapter, type ReadRequest } from "./service.types";
import { walkAncestry } from "./service.walkAncestry";

export async function readHeadAndAncestry(reader: DatasetAdapter, request: ReadRequest) {
  // Nodes FIRST, then revisions: once the head is captured it stays the
  // reference for this read even if a writer advances it, and immutable rows
  // keep the old chain complete and valid.
  await reader.refresh("nodes");
  const node = await findNode(reader, request.workspace_name, request.node_id);
  if (node === null) return null;

  const encodedNode = encodeNodeRow(node);
  const headId = encodedNode.current_revision_id;
  // A headless physical node is an integrity failure, NOT the absent result.
  if (typeof headId !== "string") failPublication("integrity_failure");

  await reader.refresh("node_revisions");
  const ancestry = await walkAncestry(reader, request.workspace_name, request.node_id, headId);
  return { node: encodedNode, headId, ancestry };
}
