import type { ApiResult } from "../api/client";
import { asError } from "../api/memory";

/** One failed `ApiResult` as the short text the evidence surface shows: the
 *  transport error verbatim, else the governed error code, else the bare
 *  status. Shared by `useEvidenceReview` and the two status resolvers so a
 *  label and a panel error never describe the same failure differently. */
export function describeResult(result: ApiResult): string {
  if (result.error !== undefined) return result.error;
  const envelope = asError(result.body);
  if (envelope !== null) return String(envelope.code);
  return `HTTP ${result.status}`;
}
