import { failPublication } from "./errors";
import type { EligibilityReason } from "./service.evaluateNodeEligibility";
import type { LifecycleLabel } from "./service.terminalEventsFor";

/**
 * DESIGN.md §9's recall-eligibility predicates as a PURE decision over rows a
 * caller already holds: the node's terminal `supersede_log` label and its
 * ENCODED head revision (`encodeRevisionRow`), at `asOf` epoch milliseconds.
 * An empty result means eligible.
 *
 * Split out of `service.evaluateNodeEligibility.ts` (overnight R18 D3, v3-list
 * fix round) so there is ONE rule and two callers: `evaluateNodeEligibility`
 * (behind `getRecallEligibility` and search's `recallEligibleNodeIds`), which
 * reads the rows itself for one node, and `listNodes`'s `eligible_only`
 * view, which already holds both rows for every candidate in its scan. A
 * second copy of these five lines inside `listNodes` would be exactly the
 * "two writable sources for one fact" the spec bans (§14.4) -- the recall
 * tools' bug was a listing and an eligibility check disagreeing.
 *
 * The half-open `[valid_from, valid_to)` window and the finite-`asOf` guard
 * are unchanged from `evaluateNodeEligibility`, where they were first pinned
 * (`test/lifecycle-eligibility-window-boundary.test.ts`). `asOf` is never
 * sampled here: the caller passes the transport's request time.
 */
export function eligibilityReasonsOf(
  lifecycle: LifecycleLabel,
  encodedRevision: Record<string, unknown>,
  asOf: number,
): EligibilityReason[] {
  if (typeof asOf !== "number" || !Number.isFinite(asOf)) failPublication("invalid_request", "");

  const reasons: EligibilityReason[] = [];
  if (lifecycle !== null) reasons.push(lifecycle.kind);
  if (encodedRevision.is_active !== true) reasons.push("inactive");
  const validFrom = encodedRevision.valid_from as string | null;
  const validTo = encodedRevision.valid_to as string | null;
  if (validFrom !== null && asOf < Date.parse(validFrom)) reasons.push("not_yet_valid");
  if (validTo !== null && asOf >= Date.parse(validTo)) reasons.push("expired");
  return reasons;
}
