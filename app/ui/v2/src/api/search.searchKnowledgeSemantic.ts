import { type ApiResult, callMethod } from "./client";
import { type Bank } from "./memory";

export const searchKnowledgeSemantic = (b: Bank, query: string, limit = 20): Promise<ApiResult> =>
  callMethod(b.bank, "searchKnowledgeSemantic", { workspace_name: b.workspace, query, limit }, b.token);
