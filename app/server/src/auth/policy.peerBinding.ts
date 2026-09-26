import { lookupPolicy } from "./policy.registry";
import { reject } from "./policy.reject";
import type { Admission, Policy } from "./policy.types";

/**
 * The `peers` binding of the grant that admitted `admission` (#87 / R3,
 * docs/overnight/DECISIONS.md), or null when that grant carries none.
 *
 * A pure LOOKUP, never a decision: it admits nothing and denies nothing. The
 * transport calls it with the SAME snapshot that just produced `admission`
 * and enforces the list itself. It sits beside the policy barrel rather than
 * in it, so the frozen §7 surface stays exactly `parsePolicy` and `admit`, and
 * an Admission still carries no policy data or peer identity.
 *
 * `invalid_request` for a snapshot this module did not parse, for a global
 * admission (the binding lives on a workspace grant), and for an admission
 * naming a principal or grant the snapshot does not hold -- a mismatched pair
 * is a wiring fault, never "unbound".
 */
export function peerBinding(policy: Policy, admission: Admission): readonly string[] | null {
  const record = policy !== null && typeof policy === "object" ? lookupPolicy(policy as object) : undefined;
  if (record === undefined) reject("invalid_request");
  const target = admission?.target;
  if (target?.kind !== "workspace") reject("invalid_request");
  const principal = Object.hasOwn(record.principalsById, admission.principal_id)
    ? record.principalsById[admission.principal_id]
    : undefined;
  if (principal === undefined) reject("invalid_request");
  const grant = principal.workspaces.find((w) => w.name === target.workspace);
  if (grant === undefined) reject("invalid_request");
  return grant.peers;
}
