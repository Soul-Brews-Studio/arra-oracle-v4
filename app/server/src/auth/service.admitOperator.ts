/**
 * #31 R25 (Nat D4b): "operator of this instance" admission for the audit
 * reader. Split out of `service.createOperationService.ts` for the file-size
 * cap, and because it is naturally one exported function.
 *
 * There is no separate "operator" action in the policy grammar
 * (`policy.types.ts`), and minting one would be a policy-format change this
 * ruling does not ask for. Holding EITHER `maintenance:backfill` or
 * `maintenance:reindex` already means "this principal may run instance-level
 * maintenance", which is exactly the scope the audit-log reader needs — a
 * workspace's `audit:read` is a different trust unit (per-workspace, checked
 * against `mcp_calls`, never this table) and is deliberately NOT accepted
 * here: a workspace-scoped principal must be refused even with `audit:read`
 * on some workspace.
 *
 * Tries `maintenance:backfill` first; only a `forbidden` denial (a real
 * credential that simply lacks that one grant) falls through to try
 * `maintenance:reindex`. Any other failure (unauthenticated, policy
 * unavailable) is NOT retried with the second action — retrying would just
 * throw the same error twice and could mask which credential state caused
 * the refusal.
 *
 * Both tries use the ONE policy snapshot and ONE clock sample the caller took
 * (contract §2: each protected request opens the policy once and samples time
 * once). An earlier version called `admitGlobal` twice, each loading its own
 * snapshot and clock, so a credential expiring between the two samples, or a
 * policy swapped between the two opens, could decide one request two ways.
 */

import { AuthDenied } from "./service.AuthDenied";

export function admitOperator<TContext, TPolicy>(
  admitGlobal: (
    authorization: string | null,
    action: "maintenance:backfill" | "maintenance:reindex",
    policy: TPolicy,
    now: number,
  ) => TContext,
  principalOf: (context: TContext) => { principalId: string | null },
  authorization: string | null,
  policy: TPolicy,
  now: number,
): { principalId: string | null } {
  try {
    return principalOf(admitGlobal(authorization, "maintenance:backfill", policy, now));
  } catch (error) {
    if (error instanceof AuthDenied && error.code === "forbidden") {
      return principalOf(admitGlobal(authorization, "maintenance:reindex", policy, now));
    }
    throw error;
  }
}
