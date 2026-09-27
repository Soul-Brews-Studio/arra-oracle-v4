import { type Bank } from "./memory";
import { call } from "./evidenceReview.call";

export const listLifecycleHistory = (b: Bank, node_id: string, after_event_id: string | null, limit: number) =>
  call(b, "listLifecycleHistory", { node_id, after_event_id, limit });
