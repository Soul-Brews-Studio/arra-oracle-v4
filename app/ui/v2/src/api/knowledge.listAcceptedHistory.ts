import { type Bank } from "./memory";
import { call } from "./knowledge.call";

export const listAcceptedHistory = (b: Bank, node_id: string) =>
  call(b, "listAcceptedHistory", { workspace_name: b.workspace, node_id });
