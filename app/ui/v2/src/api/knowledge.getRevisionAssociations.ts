import { type Bank } from "./memory";
import { call } from "./knowledge.call";

export const getRevisionAssociations = (b: Bank, node_id: string, revision_id: string | null = null) =>
  call(b, "getRevisionAssociations", { workspace_name: b.workspace, node_id, revision_id });
