import { requireClosedObject, requireNanoid21 } from "../../contracts/common";
import { name } from "./name";
import { parseRequest } from "./parse-request";

export type ReconcileRequest = {
  workspace_name: string;
  node_id: string;
  revision_id: string;
};

export function parseReconcileRevisionAssociations(bytes: Uint8Array): ReconcileRequest {
  const o = requireClosedObject(parseRequest(bytes), ["workspace_name", "node_id", "revision_id"], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    node_id: requireNanoid21(o.get("node_id") ?? null, ["node_id"]),
    // REQUIRED nonnull: a materializer must name the revision it materializes.
    revision_id: requireNanoid21(o.get("revision_id") ?? null, ["revision_id"]),
  };
}
