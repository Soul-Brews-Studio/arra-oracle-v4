import { createHash } from "node:crypto";
import { BEARER_PATTERN, MAX_NOW_MS, MIN_NOW_MS, POLICY_VERSION } from "./constants";
import { findCredential } from "./find-credential";
import { parseTarget } from "./parse-target";
import { lookupPolicy } from "./registry";
import { reject } from "./reject";
import { requireClosedInput } from "./require-closed-input";
import type { Admission, AdmissionInput, Policy } from "./types";

/**
 * Decide one request against one immutable snapshot and one caller-supplied
 * epoch-millisecond value.
 *
 * Order is fixed by contract: trusted invocation shape and clock, header
 * grammar, digest comparison, exactly one enabled credential with an enabled
 * principal, the time window, then the exact grant. Every authentication-stage
 * failure collapses to `unauthenticated`; only an authenticated principal
 * lacking the exact grant is `forbidden`.
 */
export function admit(policy: Policy, input: AdmissionInput): Admission {
  const record =
    policy !== null && typeof policy === "object" ? lookupPolicy(policy as object) : undefined;
  if (record === undefined) reject("invalid_request");

  const o = requireClosedInput(input, ["authorization", "now_ms", "target"]);

  const nowMs = o.now_ms;
  if (typeof nowMs !== "number" || !Number.isSafeInteger(nowMs)) reject("invalid_request");
  if (nowMs < MIN_NOW_MS || nowMs > MAX_NOW_MS) reject("invalid_request");

  const target = parseTarget(o.target);

  // Only now does anything about the presented credential matter, so a bad
  // clock or a malformed target can never be reported as an auth failure.
  const authorization = o.authorization;
  if (typeof authorization !== "string" || !BEARER_PATTERN.test(authorization)) {
    reject("unauthenticated");
  }

  const token = authorization.slice(authorization.indexOf(" ") + 1);
  const presented = createHash("sha256").update(token, "ascii").digest();

  const credential = findCredential(record.credentials, presented);
  if (credential === null || credential.revoked) reject("unauthenticated");

  const principal = Object.hasOwn(record.principalsById, credential.principalId)
    ? record.principalsById[credential.principalId]
    : undefined;
  if (principal === undefined || principal.disabled) reject("unauthenticated");

  if (!(credential.notBeforeMs <= nowMs && nowMs < credential.expiresAtMs)) reject("unauthenticated");

  // Exact grant only: no union across credentials, principals or workspaces,
  // and no prefix, wildcard or case-insensitive workspace matching.
  const granted =
    target.kind === "workspace"
      ? principal.workspaces.some(
          (w) => w.name === target.workspace && w.actions.includes(target.action),
        )
      : principal.globalActions.includes(target.action);
  if (!granted) reject("forbidden");

  return Object.freeze({
    policy_version: POLICY_VERSION,
    principal_id: principal.id,
    credential_id: credential.id,
    target,
  });
}
