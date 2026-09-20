/**
 * #25 first slice: pure policy validation and admission (`authorization-v1.md` §7).
 *
 * Isolated on purpose. Nothing here reads a file, an environment variable, a
 * clock, a route, the store or a model; the caller supplies the raw bytes and
 * the one epoch-millisecond value a request is decided against. This module is
 * NOT a secured service — integration owns unforgeable context construction and
 * entrypoint wiring, and none of that is claimed by these two functions.
 *
 * Every rejection is an Error carrying one closed `code` and a fixed generic
 * message for that code. The shared contract helpers are reused for strict
 * JSON, Unicode and timestamp grammar, but their diagnostic paths and messages
 * are deliberately swallowed: a policy diagnostic must never echo a token, a
 * digest, a workspace name or a fragment of the document.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { requireClosedObject, type Tokens } from "../contracts/common";
import {
  hasOnlyPairedSurrogates,
  type JcsObject,
  type JcsValue,
  parseStrictBytes,
  utf8ByteLength,
} from "../contracts/jcs";
import { parseTimestamp } from "../contracts/v1";

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

const POLICY_VERSION: PolicyVersion = "arra-auth/v1";

const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_DEPTH = 16;
const MAX_PRINCIPALS = 256;
const MAX_CREDENTIALS = 1024;
const MAX_WORKSPACES_PER_PRINCIPAL = 256;
const MAX_WORKSPACE_NAME_BYTES = 256;

/** Canonical Gregorian 0001-01-01T00:00:00.000Z .. 9999-12-31T23:59:59.999Z. */
const MIN_NOW_MS = -62135596800000;
const MAX_NOW_MS = 253402300799999;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Case-insensitive scheme, exactly one ASCII space, 64 lowercase hex. Anchored. */
const BEARER_PATTERN = /^[Bb][Ee][Aa][Rr][Ee][Rr] [0-9a-f]{64}$/;

const WORKSPACE_ACTIONS: readonly WorkspaceAction[] = [
  "content:read",
  "content:write",
  "audit:read",
  "diagnostics:read",
];
const GLOBAL_ACTIONS: readonly GlobalAction[] = ["maintenance:backfill", "maintenance:reindex"];

const ROOT_KEYS = ["version", "principals", "credentials"] as const;
const PRINCIPAL_KEYS = ["id", "disabled", "workspaces", "global_actions"] as const;
const WORKSPACE_KEYS = ["name", "actions"] as const;
const CREDENTIAL_KEYS = ["id", "principal_id", "sha256", "not_before", "expires_at", "revoked"] as const;

const MESSAGES: Readonly<Record<AuthErrorCode, string>> = Object.freeze({
  policy_invalid: "policy is invalid",
  invalid_request: "invalid request",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
});

/**
 * Not exported: the module's two runtime exports are `parsePolicy` and `admit`.
 * Callers discriminate on the readonly `code`, never on the class or prose.
 */
class AuthError extends Error {
  readonly code!: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(MESSAGES[code]);
    this.name = "AuthError";
    // `readonly` alone is erased at runtime, so define the property as
    // genuinely non-writable rather than claiming immutability TS cannot keep.
    Object.defineProperty(this, "code", {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}

function reject(code: AuthErrorCode): never {
  throw new AuthError(code);
}

/**
 * Run a shared contract helper and discard everything it says on failure. The
 * helpers raise precise pointers and messages by design; surfacing those here
 * would leak policy structure and values into a public authentication error.
 */
function opaque<T>(run: () => T, code: AuthErrorCode): T {
  try {
    return run();
  } catch {
    return reject(code);
  }
}

type WorkspaceGrant = { readonly name: string; readonly actions: readonly WorkspaceAction[] };

type PrincipalRecord = {
  readonly id: string;
  readonly disabled: boolean;
  readonly workspaces: readonly WorkspaceGrant[];
  readonly globalActions: readonly GlobalAction[];
};

type CredentialRecord = {
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

type PolicyRecord = {
  readonly version: PolicyVersion;
  /** Frozen null-prototype lookup; a Map would be mutable despite any freeze. */
  readonly principalsById: Readonly<Record<string, PrincipalRecord>>;
  readonly credentials: readonly CredentialRecord[];
};

/**
 * The construction boundary. A handle only authorizes if this module minted it,
 * so JSON copies, spread clones and prototype lookalikes are rejected. This is
 * an in-process boundary, not protection against arbitrary code in the process.
 */
const REGISTRY = new WeakMap<object, PolicyRecord>();

// ── policy parsing ──────────────────────────────────────────────────────────

const NO_TOKENS: Tokens = [];

function closed(value: JcsValue, keys: readonly string[]): JcsObject {
  return opaque(() => requireClosedObject(value, keys, NO_TOKENS), "policy_invalid");
}

function field(o: JcsObject, key: string): JcsValue {
  return o.get(key) as JcsValue;
}

function requireArrayValue(value: JcsValue): JcsValue[] {
  if (!Array.isArray(value)) reject("policy_invalid");
  return value;
}

function requireBooleanValue(value: JcsValue): boolean {
  if (typeof value !== "boolean") reject("policy_invalid");
  return value;
}

function requireId(value: JcsValue): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) reject("policy_invalid");
  return value;
}

function requireWorkspaceName(value: JcsValue): string {
  if (typeof value !== "string" || value.trim().length === 0) reject("policy_invalid");
  // No Unicode check here: the strict parser already rejects a lone surrogate
  // (including the `"\ud800"` escape form) with `invalid_unicode` before any
  // value reaches this function. A second check would be unreachable, and
  // unreachable code reads as a safeguard that is actually never exercised.
  // The cap is UTF-8 BYTES, so a multi-byte name is measured as it is stored.
  // No trimming and no case folding: the stored name is the exact match key.
  if (utf8ByteLength(value) > MAX_WORKSPACE_NAME_BYTES) reject("policy_invalid");
  return value;
}

function requireActions<T extends string>(value: JcsValue, allowed: readonly T[]): T[] {
  const raw = requireArrayValue(value);
  const actions: T[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !(allowed as readonly string[]).includes(entry)) {
      reject("policy_invalid");
    }
    actions.push(entry as T);
  }
  return actions;
}

function requireTimestampMs(value: JcsValue): number {
  if (typeof value !== "string") reject("policy_invalid");
  const parsed = opaque(() => parseTimestamp(value), "policy_invalid");
  return parsed.getTime();
}

function requireDigest(value: JcsValue): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) reject("policy_invalid");
  return value;
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function parseWorkspaceGrant(value: JcsValue): WorkspaceGrant {
  const o = closed(value, WORKSPACE_KEYS);
  const name = requireWorkspaceName(field(o, "name"));
  const actions = requireActions(field(o, "actions"), WORKSPACE_ACTIONS);
  return Object.freeze({ name, actions: Object.freeze(actions) });
}

function parsePrincipal(value: JcsValue): PrincipalRecord {
  const o = closed(value, PRINCIPAL_KEYS);
  const id = requireId(field(o, "id"));
  const disabled = requireBooleanValue(field(o, "disabled"));
  const rawWorkspaces = requireArrayValue(field(o, "workspaces"));
  // Collection limits precede element validation.
  if (rawWorkspaces.length > MAX_WORKSPACES_PER_PRINCIPAL) reject("policy_invalid");
  const workspaces = rawWorkspaces.map(parseWorkspaceGrant);
  const globalActions = requireActions(field(o, "global_actions"), GLOBAL_ACTIONS);
  return Object.freeze({
    id,
    disabled,
    workspaces: Object.freeze(workspaces),
    globalActions: Object.freeze(globalActions),
  });
}

function parseCredential(value: JcsValue): CredentialRecord {
  const o = closed(value, CREDENTIAL_KEYS);
  const id = requireId(field(o, "id"));
  const principalId = requireId(field(o, "principal_id"));
  const digestHex = requireDigest(field(o, "sha256"));
  const notBeforeMs = requireTimestampMs(field(o, "not_before"));
  const expiresAtMs = requireTimestampMs(field(o, "expires_at"));
  const revoked = requireBooleanValue(field(o, "revoked"));
  return Object.freeze({ id, principalId, digestHex, notBeforeMs, expiresAtMs, revoked });
}

/**
 * Validate a complete policy document and return an opaque frozen snapshot.
 *
 * Order is fixed by contract: original byte cap, fatal UTF-8 decode, strict
 * JSON with duplicate-key and depth rejection, root shape, principals in array
 * order, credentials in array order, then uniqueness, references and times.
 */
export function parsePolicy(raw: Uint8Array): Policy {
  // `instanceof` alone would accept a Buffer, which is fine, but a DataView or
  // ArrayBuffer is not a byte array and must not be coerced into one.
  if (!(raw instanceof Uint8Array)) reject("policy_invalid");

  // Byte cap and fatal UTF-8 both happen inside the shared strict parser, in
  // that order, against the ORIGINAL bytes -- never against a re-encoding.
  const document = opaque(
    () => parseStrictBytes(raw, NO_TOKENS, { maxBytes: MAX_DOCUMENT_BYTES, maxDepth: MAX_DEPTH }),
    "policy_invalid",
  );

  const root = closed(document, ROOT_KEYS);
  if (field(root, "version") !== POLICY_VERSION) reject("policy_invalid");

  const rawPrincipals = requireArrayValue(field(root, "principals"));
  if (rawPrincipals.length > MAX_PRINCIPALS) reject("policy_invalid");
  const principals = rawPrincipals.map(parsePrincipal);

  const rawCredentials = requireArrayValue(field(root, "credentials"));
  if (rawCredentials.length > MAX_CREDENTIALS) reject("policy_invalid");
  const credentials = rawCredentials.map(parseCredential);

  // Cross-cutting checks, in contract order, after every shape and value passed.
  if (hasDuplicate(principals.map((p) => p.id))) reject("policy_invalid");
  for (const principal of principals) {
    if (hasDuplicate(principal.workspaces.map((w) => w.name))) reject("policy_invalid");
    for (const w of principal.workspaces) {
      if (hasDuplicate(w.actions)) reject("policy_invalid");
    }
    if (hasDuplicate(principal.globalActions)) reject("policy_invalid");
  }
  if (hasDuplicate(credentials.map((c) => c.id))) reject("policy_invalid");
  if (hasDuplicate(credentials.map((c) => c.digestHex))) reject("policy_invalid");

  const principalsById: Record<string, PrincipalRecord> = Object.create(null);
  for (const principal of principals) principalsById[principal.id] = principal;
  Object.freeze(principalsById);
  for (const credential of credentials) {
    if (!Object.hasOwn(principalsById, credential.principalId)) reject("policy_invalid");
  }
  for (const credential of credentials) {
    if (!(credential.notBeforeMs < credential.expiresAtMs)) reject("policy_invalid");
  }

  const record: PolicyRecord = Object.freeze({
    version: POLICY_VERSION,
    principalsById,
    credentials: Object.freeze(credentials),
  });

  // The handle carries no data at all; everything lives in the private map.
  const handle = Object.freeze(Object.create(null)) as Policy;
  REGISTRY.set(handle, record);
  return handle;
}

// ── admission ───────────────────────────────────────────────────────────────

/** True only for an ordinary own-data-property value: no getters, no inherited keys. */
function ownData(o: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(o, key);
  return descriptor !== undefined && "value" in descriptor;
}

function requireClosedInput(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("invalid_request");
  const o = value as Record<string, unknown>;
  for (const key of keys) {
    if (!ownData(o, key)) reject("invalid_request");
  }
  if (Reflect.ownKeys(o).length !== keys.length) reject("invalid_request");
  return o;
}

function parseTarget(value: unknown): AdmissionTarget {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("invalid_request");
  // Read `kind` through its descriptor: a plain property access would INVOKE a
  // getter, letting caller code run (and throw) inside the authorization path
  // before the own-data boundary is enforced. Proxies remain unsupported.
  if (!ownData(value, "kind")) reject("invalid_request");
  const kind = Object.getOwnPropertyDescriptor(value, "kind")!.value as unknown;
  if (kind === "workspace") {
    const o = requireClosedInput(value, ["kind", "workspace", "action"]);
    const workspace = o.workspace;
    if (typeof workspace !== "string" || workspace.trim().length === 0) reject("invalid_request");
    // Same grammar as a policy workspace name, INCLUDING valid Unicode: a lone
    // surrogate is a malformed request, decided before any credential lookup.
    if (!hasOnlyPairedSurrogates(workspace)) reject("invalid_request");
    if (utf8ByteLength(workspace) > MAX_WORKSPACE_NAME_BYTES) reject("invalid_request");
    const action = o.action;
    if (typeof action !== "string" || !(WORKSPACE_ACTIONS as readonly string[]).includes(action)) {
      reject("invalid_request");
    }
    return Object.freeze({ kind: "workspace", workspace, action: action as WorkspaceAction });
  }
  if (kind === "global") {
    const o = requireClosedInput(value, ["kind", "action"]);
    const action = o.action;
    if (typeof action !== "string" || !(GLOBAL_ACTIONS as readonly string[]).includes(action)) {
      reject("invalid_request");
    }
    return Object.freeze({ kind: "global", action: action as GlobalAction });
  }
  return reject("invalid_request");
}

/**
 * Compare the presented digest against every credential digest with a
 * fixed-length timing-safe primitive, without early exit.
 *
 * Only this comparison loop is timing-safe; no claim is made about the whole
 * request, the parser, or policy lookup generally.
 */
function findCredential(
  credentials: readonly CredentialRecord[],
  presented: Buffer,
): CredentialRecord | null {
  let match: CredentialRecord | null = null;
  let matches = 0;
  for (const credential of credentials) {
    // Both operands are exactly 32 bytes: the stored hex is validated as 64
    // lowercase hex at parse time, and `presented` is a SHA-256 output.
    if (timingSafeEqual(Buffer.from(credential.digestHex, "hex"), presented)) {
      match = credential;
      matches += 1;
    }
  }
  // Parsing rejects duplicate digests, so more than one match cannot happen;
  // if it somehow did, admitting an ambiguous credential would be worse.
  return matches === 1 ? match : null;
}

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
    policy !== null && typeof policy === "object" ? REGISTRY.get(policy as object) : undefined;
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
