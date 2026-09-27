import { type ApiResult } from "./client";
import { type RecallEligibility } from "./evidenceReview";

export function recallEligibilityOf(result: ApiResult): RecallEligibility | null {
  if (!result.ok) return null;
  const body = result.body as Partial<RecallEligibility> | null;
  if (typeof body?.eligible !== "boolean" || typeof body?.witness_event_id !== "string") return null;
  return { eligible: body.eligible, witness_event_id: body.witness_event_id };
}
