import { type Bank } from "./memory";
import { call } from "./knowledge.call";

export const getAcceptedHead = (b: Bank, node_id: string) =>
  call(b, "getAcceptedHead", { workspace_name: b.workspace, node_id });
