/** Shared constants for policy parsing and admission, used by several functions. */

import type { GlobalAction, PolicyVersion, WorkspaceAction } from "./policy.types";

export const POLICY_VERSION: PolicyVersion = "arra-auth/v1";

export const MAX_DOCUMENT_BYTES = 256 * 1024;
export const MAX_DEPTH = 16;
export const MAX_PRINCIPALS = 256;
export const MAX_CREDENTIALS = 1024;
export const MAX_WORKSPACES_PER_PRINCIPAL = 256;
export const MAX_WORKSPACE_NAME_BYTES = 256;

/** Canonical Gregorian 0001-01-01T00:00:00.000Z .. 9999-12-31T23:59:59.999Z. */
export const MIN_NOW_MS = -62135596800000;
export const MAX_NOW_MS = 253402300799999;

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Case-insensitive scheme, exactly one ASCII space, 64 lowercase hex. Anchored. */
export const BEARER_PATTERN = /^[Bb][Ee][Aa][Rr][Ee][Rr] [0-9a-f]{64}$/;

export const WORKSPACE_ACTIONS: readonly WorkspaceAction[] = [
  "content:read",
  "content:write",
  "audit:read",
  "diagnostics:read",
];
export const GLOBAL_ACTIONS: readonly GlobalAction[] = ["maintenance:backfill", "maintenance:reindex"];

export const ROOT_KEYS = ["version", "principals", "credentials"] as const;
export const PRINCIPAL_KEYS = ["id", "disabled", "workspaces", "global_actions"] as const;
export const WORKSPACE_KEYS = ["name", "actions"] as const;
export const CREDENTIAL_KEYS = ["id", "principal_id", "sha256", "not_before", "expires_at", "revoked"] as const;
