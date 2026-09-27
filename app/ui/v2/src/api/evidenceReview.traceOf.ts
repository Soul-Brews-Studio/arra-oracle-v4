import { type ApiResult } from "./client";
import { type TraceRow } from "./evidenceReview";

/** `service.getTrace.ts` returns the stored row directly (or `null`), NOT a
 *  `{trace: ...}` wrapper -- verified against the kernel, the same "read the
 *  actual envelope key, not the analogous-looking one" trap `api/listing.ts`
 *  hit for `listPeers`. `null` is an ANSWER ("no such trace"), the same
 *  "null is not an error" contract `getAcceptedHead` uses. */
export function traceOf(result: ApiResult): TraceRow | null {
  if (!result.ok) return null;
  return (result.body as TraceRow | null) ?? null;
}
