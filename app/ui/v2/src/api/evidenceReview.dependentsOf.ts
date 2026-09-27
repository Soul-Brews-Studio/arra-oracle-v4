import { type ApiResult } from "./client";
import { type DependentOccurrence, type DependentsCursor } from "./evidenceReview";

export function dependentsOf(result: ApiResult): {
  outcome: "page" | "restart_required" | "error";
  occurrences: DependentOccurrence[];
  nextCursor: DependentsCursor | null;
} {
  if (!result.ok) return { outcome: "error", occurrences: [], nextCursor: null };
  const body = result.body as
    | { outcome?: string; occurrences?: DependentOccurrence[]; next_cursor?: DependentsCursor | null }
    | null;
  if (body?.outcome === "restart_required") return { outcome: "restart_required", occurrences: [], nextCursor: null };
  return {
    outcome: "page",
    occurrences: Array.isArray(body?.occurrences) ? (body!.occurrences as DependentOccurrence[]) : [],
    nextCursor: body?.next_cursor ?? null,
  };
}
