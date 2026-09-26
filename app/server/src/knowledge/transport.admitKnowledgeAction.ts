import { admit, type Admission, type AdmissionTarget } from "../auth/policy";
import { loadPolicy } from "../auth/loader";
import { peerBinding } from "../auth/policy.peerBinding";
import type { KnowledgeAction, RequestAuthority } from "./registry";

// Moved out of `transport.ts` unchanged except for the #87 / R3 authority it
// now returns, which pushed that file past the 500-line cap. `transport.ts`
// re-exports all three names, so no import site changes.

export type KnowledgeAuthFailure = "unauthenticated" | "forbidden" | "policy_unavailable";

export class KnowledgeAuthDenied extends Error {
  readonly code: KnowledgeAuthFailure;
  constructor(code: KnowledgeAuthFailure) {
    super(code);
    this.code = code;
  }
}

/**
 * Admit exactly one workspace action, reusing the #25 admission primitives
 * (`admit`, `loadPolicy`) directly — the same pure decision the memories
 * transport in `auth/service.ts` is built on. This module does not reinvent
 * policy evaluation; it only supplies the target for a different domain.
 *
 * Returns the request's `RequestAuthority` (#87 / R3), built from the SAME
 * snapshot and the SAME clock value that admitted it: `operator` is a second
 * `admit` of `audit:read` on this workspace (never inferred from the grant
 * shape), `peers` is that grant's arra-auth/v1 binding.
 */
export function admitKnowledgeAction(
  policyPath: string,
  authorization: string | null,
  workspace: string,
  action: KnowledgeAction,
): RequestAuthority {
  let policy;
  try {
    policy = loadPolicy(policyPath);
  } catch {
    throw new KnowledgeAuthDenied("policy_unavailable");
  }
  const now_ms = Date.now();
  const target: AdmissionTarget = { kind: "workspace", workspace, action };
  let admission: Admission;
  try {
    admission = admit(policy, { authorization, now_ms, target });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "unauthenticated") throw new KnowledgeAuthDenied("unauthenticated");
    if (code === "forbidden") throw new KnowledgeAuthDenied("forbidden");
    throw new KnowledgeAuthDenied("policy_unavailable");
  }
  let operator = action === "audit:read";
  if (!operator) {
    try {
      admit(policy, { authorization, now_ms, target: { kind: "workspace", workspace, action: "audit:read" } });
      operator = true;
    } catch {
      operator = false;
    }
  }
  try {
    return Object.freeze({ operator, peers: peerBinding(policy, admission) });
  } catch {
    // Only a snapshot/admission mismatch can land here: fail closed.
    throw new KnowledgeAuthDenied("policy_unavailable");
  }
}
