import { type Count } from "./overview";

export const pendingCount = (method: string): Count => ({
  method, total: null, outcome: "pending", note: "not probed yet", durationMs: 0,
});
