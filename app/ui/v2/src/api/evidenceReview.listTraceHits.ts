import { type Bank } from "./memory";
import { call } from "./evidenceReview.call";

export const listTraceHits = (b: Bank, trace_id: string, after_position: string | null, limit: number) =>
  call(b, "listTraceHits", { trace_id, after_position, limit });
