import { requireClosedObject, requireNanoid21 } from "../contracts/common";
import { name } from "./association.name";
import { parseRequest } from "./association.parseRequest";

export type GetRevisionAssociationsRequest = {
  workspace_name: string;
  node_id: string;
  revision_id: string | null;
};

export function parseGetRevisionAssociations(bytes: Uint8Array): GetRevisionAssociationsRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "node_id", "revision_id"], []);
  const rawRevision = o.get("revision_id");
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    node_id: requireNanoid21(o.get("node_id") ?? null, ["node_id"]),
    // null means the CAPTURED HEAD, and is distinct from omitting the key.
    revision_id: rawRevision === null ? null : requireNanoid21(rawRevision ?? null, ["revision_id"]),
  };
}
