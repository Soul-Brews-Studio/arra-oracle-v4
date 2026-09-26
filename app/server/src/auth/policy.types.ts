/**
 * Shared types for policy parsing and admission (`authorization-v1.md` §7).
 * Split out of `policy.ts` because every function in this directory needs at
 * least one of these; colocating them here avoids one function "owning" types
 * several others depend on.
 */

export type PolicyVersion = "arra-auth/v1";
export type WorkspaceAction = "content:read" | "content:write" | "audit:read" | "diagnostics:read";
export type GlobalAction = "maintenance:backfill" | "maintenance:reindex";

export type AdmissionTarget =
  | { readonly kind: "workspace"; readonly workspace: string; readonly action: WorkspaceAction }
  | { readonly kind: "global"; readonly action: GlobalAction };

export type AdmissionInput = {
  readonly authorization: string | null;
  readonly now_ms: number;
  readonly target: AdmissionTarget;
};

export type Admission = {
  readonly policy_version: PolicyVersion;
  readonly principal_id: string;
  readonly credential_id: string;
  readonly target: AdmissionTarget;
};

/** Opaque handle. Its data lives in a module-private WeakMap, never on the object. */
export type Policy = { readonly __policy: unique symbol };

export type AuthErrorCode = "policy_invalid" | "invalid_request" | "unauthenticated" | "forbidden";

export type WorkspaceGrant = {
  readonly name: string;
  readonly actions: readonly WorkspaceAction[];
  /**
   * #87 / R3 anti-spoofing binding (docs/overnight/DECISIONS.md): when a list,
   * every peer name this principal asserts in a request on this workspace must
   * be in it. Null when the grant carries no `peers` key -- then the trust unit
   * stays the workspace, exactly as before. It grants nothing by itself.
   */
  readonly peers: readonly string[] | null;
};

export type PrincipalRecord = {
  readonly id: string;
  readonly disabled: boolean;
  readonly workspaces: readonly WorkspaceGrant[];
  readonly globalActions: readonly GlobalAction[];
};

export type CredentialRecord = {
  readonly id: string;
  readonly principalId: string;
  /**
   * Digest as lowercase hex TEXT, not bytes. A Buffer/TypedArray cannot be
   * frozen (`Object.freeze` rejects views with elements), so storing bytes
   * would make the "recursively frozen backing records" guarantee false. The
   * fixed-length byte comparison materialises its buffers per check instead.
   */
  readonly digestHex: string;
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
  readonly revoked: boolean;
};

export type PolicyRecord = {
  readonly version: PolicyVersion;
  /** Frozen null-prototype lookup; a Map would be mutable despite any freeze. */
  readonly principalsById: Readonly<Record<string, PrincipalRecord>>;
  readonly credentials: readonly CredentialRecord[];
};
