import { type ApiResult } from "./client";
import { type AssociationResult } from "./evidenceReview";

/** The kernel answers a bare `null` for "no such node/revision on accepted
 *  ancestry" -- an ANSWER, the same "null is not an error" contract
 *  `getAcceptedHead`/`getTrace` use, not a shape to reject. */
export function associationsOf(result: ApiResult): AssociationResult | null {
  if (!result.ok) return null;
  return (result.body as AssociationResult | null) ?? null;
}
