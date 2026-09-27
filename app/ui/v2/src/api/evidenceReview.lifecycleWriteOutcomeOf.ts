import { type ApiResult } from "./client";
import { type LifecycleWriteOutcome } from "./evidenceReview";

/** `service.writeLifecycleEvent.ts`'s three outcomes. The stored `row` is
 *  intentionally NOT surfaced here: the caller already knows what it asked
 *  for, and a fresh `listLifecycleHistory`/`getRecallEligibility` refetch
 *  (which every caller of this does) is the authoritative post-write read,
 *  not a second, divergent shape carried on the write response. */
export function lifecycleWriteOutcomeOf(result: ApiResult): LifecycleWriteOutcome | null {
  if (!result.ok) return null;
  const body = result.body as { outcome?: string; reason?: string } | null;
  if (body?.outcome === "accepted" || body?.outcome === "idempotent") return { outcome: body.outcome };
  if (body?.outcome === "conflict" && typeof body.reason === "string") {
    return { outcome: "conflict", reason: body.reason };
  }
  return null;
}
