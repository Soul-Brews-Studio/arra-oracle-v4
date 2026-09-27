import { type ApiResult } from "./client";
import { type TraceHitRow } from "./evidenceReview";

export function hitsOf(result: ApiResult): { rows: TraceHitRow[]; nextAfterPosition: string | null } {
  if (!result.ok) return { rows: [], nextAfterPosition: null };
  const body = result.body as { rows?: TraceHitRow[]; next_after_position?: string | null } | null;
  return {
    rows: Array.isArray(body?.rows) ? (body!.rows as TraceHitRow[]) : [],
    nextAfterPosition: typeof body?.next_after_position === "string" ? body.next_after_position : null,
  };
}
