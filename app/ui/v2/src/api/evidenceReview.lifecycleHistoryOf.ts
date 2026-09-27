import { type ApiResult } from "./client";
import { type LifecycleEventRow } from "./evidenceReview";

export function lifecycleHistoryOf(result: ApiResult): {
  rows: LifecycleEventRow[];
  nextAfterEventId: string | null;
} {
  if (!result.ok) return { rows: [], nextAfterEventId: null };
  const body = result.body as { rows?: LifecycleEventRow[]; next_after_event_id?: string | null } | null;
  return {
    rows: Array.isArray(body?.rows) ? (body!.rows as LifecycleEventRow[]) : [],
    nextAfterEventId: typeof body?.next_after_event_id === "string" ? body.next_after_event_id : null,
  };
}
