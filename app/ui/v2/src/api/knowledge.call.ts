import { type ApiResult, callMethod } from "./client";
import { type Bank } from "./memory";

export const call = (b: Bank, method: string, body: Record<string, unknown>): Promise<ApiResult> =>
  callMethod(b.bank, method, body, b.token);
