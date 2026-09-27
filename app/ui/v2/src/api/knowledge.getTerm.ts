import { type Bank } from "./memory";
import { call } from "./knowledge.call";

export const getTerm = (b: Bank, term_id: string) =>
  call(b, "getTerm", { workspace_name: b.workspace, term_id });
