/**
 * The single admission boundary (`authorization-integration-v1.md` §3).
 *
 * Every transport — HTTP, MCP, and anything the CLI or browser drives — reaches
 * the store only through the facade built here. Adapters receive this facade;
 * they never receive a raw store handle, and they cannot construct a request
 * context, because the only constructor is private to this module and accepts
 * an Admission solely in the same call frame that produced it.
 *
 * A TypeScript type is not proof of authorization: a caller can always assert
 * one. So provenance is checked at runtime through a module-private WeakMap,
 * and a context created anywhere else is rejected before any store call.
 */

import { admit, type Admission, type GlobalAction, type Policy, type WorkspaceAction } from "./policy";
import { loadPolicy } from "./loader.loadPolicy";
import { peerBinding } from "./policy.peerBinding";
import { isBoundAuthor } from "./service.isBoundAuthor";
import { TOOL_NAMES } from "../mcp/tools";
import { V3_TOOL_NAMES } from "../mcp/legacy-v3/catalogue";
import type { RequestAuthority } from "../knowledge/registry";
import { bindToolOperations } from "./service.bindToolOperations";
import { resolveToolName } from "./service.resolveToolName";
import { toolAction } from "./service.toolAction";
import { toolAlsoNeeds } from "./service.toolAlsoNeeds";
import { auditErrorText } from "./service.auditErrorText";
import { auditedHttpCall } from "./service.auditedHttpCall";
import { searchAnswer } from "./service.searchAnswer";
import { AuthDenied, type AuthFailure } from "./service.AuthDenied";
import { withInstanceAudit } from "./service.withInstanceAudit";
import type { HttpAudit, McpEnvelope, McpResult, StoreDependencies, TextSearchResult, ToolOperations } from "./service.types";

export type { HttpAudit, McpEnvelope, McpResult, StoreDependencies, TextSearchResult, ToolOperations } from "./service.types";

// The denial class lives in its own file (line cap); re-exported unchanged.
export { AuthDenied, type AuthFailure } from "./service.AuthDenied";

// A function DECLARATION, not an arrow: TypeScript only uses a `never` return
// for control-flow narrowing when the callee is declared this way.
function deny(code: AuthFailure): never {
  throw new AuthDenied(code);
}

/** Opaque per-request context. Its data lives only in the private map below. */
export type RequestContext = { readonly __context: unique symbol };

type ContextRecord = {
  readonly principalId: string;
  readonly credentialId: string;
  readonly policyVersion: string;
  readonly workspace: string | null;
  readonly action: WorkspaceAction | GlobalAction;
};

const CONTEXTS = new WeakMap<object, ContextRecord>();

/**
 * The private constructor. It takes the Admission in the SAME frame that called
 * admit, so no exported path can hand one in from outside.
 */
function contextFrom(admission: Admission): RequestContext {
  const handle = Object.freeze(Object.create(null)) as RequestContext;
  CONTEXTS.set(
    handle,
    Object.freeze({
      principalId: admission.principal_id,
      credentialId: admission.credential_id,
      policyVersion: admission.policy_version,
      workspace: admission.target.kind === "workspace" ? admission.target.workspace : null,
      action: admission.target.action,
    }),
  );
  return handle;
}
const principalOf = (c: RequestContext) => ({ principalId: CONTEXTS.get(c as object)?.principalId ?? null }); // #31 D4b

/** Reject anything this module did not mint, then require the exact action. */
function recordFor(
  context: RequestContext,
  expected: { workspace?: string; action: WorkspaceAction | GlobalAction },
): ContextRecord {
  const record =
    context !== null && typeof context === "object" ? CONTEXTS.get(context as object) : undefined;
  if (record === undefined) deny("invalid_request");
  // A read context handed to a write method must fail here, before any store.
  if (record.action !== expected.action) deny("forbidden");
  if (expected.workspace !== undefined && record.workspace !== expected.workspace) deny("forbidden");
  return record;
}

export type Target =
  | { readonly kind: "workspace"; readonly workspace: string; readonly action: WorkspaceAction }
  | { readonly kind: "global"; readonly action: GlobalAction };

/** Maps the pure module's codes onto this layer's, with no extra detail. */
function admitOrDeny(policy: Policy, authorization: string | null, nowMs: number, target: Target): Admission {
  try {
    return admit(policy, { authorization, now_ms: nowMs, target } as never);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "forbidden") deny("forbidden");
    if (code === "unauthenticated") deny("unauthenticated");
    // invalid_request/policy_invalid from the pure module means this layer built
    // a bad call or the snapshot is unusable: fail closed, never fall through.
    return deny("policy_unavailable");
  }
}

/**
 * The four MCP actions, admitted in this fixed order for the route workspace.
 */
const MCP_ACTION_ORDER: readonly WorkspaceAction[] = [
  "content:read",
  "content:write",
  "audit:read",
  "diagnostics:read",
];

// The tool -> action map lives in `service.toolAction.ts`: owned by this
// service, derived from each family's data table, never chosen by an adapter.

export type ServiceConfig = {
  readonly policyPath: string;
  /** R18 D10: `ARRA_MCP_V3_COMPAT`, trusted operator configuration. Absent = off. */
  readonly v3Compat?: boolean;
};
export type Clock = () => number;

/**
 * The public service. Every entrypoint takes CREDENTIALS plus the request
 * scope and performs admission itself; no caller can supply an Admission or a
 * context, because neither type can be constructed outside this module.
 */
export type OperationService = ReturnType<typeof createOperationService>;

export function createOperationService(
  config: ServiceConfig,
  deps: StoreDependencies,
  clock: Clock = Date.now,
) {
  // #31 D4b: a no-op when the caller wired no real sink (`service.types.ts` field doc).
  const logInstanceAudit = deps.logInstanceAudit ?? (async () => {});
  const snapshot = (): Policy => {
    try {
      return loadPolicy(config.policyPath);
    } catch {
      return deny("policy_unavailable");
    }
  };

  /** Admit one workspace action and return a private context. */
  function admitWorkspace(
    authorization: string | null,
    workspace: string,
    action: WorkspaceAction,
  ): RequestContext {
    const policy = snapshot();
    const now = clock();
    return contextFrom(admitOrDeny(policy, authorization, now, { kind: "workspace", workspace, action }));
  }

  function admitGlobal(authorization: string | null, action: GlobalAction): RequestContext {
    const policy = snapshot();
    const now = clock();
    return contextFrom(admitOrDeny(policy, authorization, now, { kind: "global", action }));
  }

  /** #87 / R3: the admitting grant's `peers` binding (null = unbound). A
   *  snapshot/admission mismatch is a wiring fault, so it fails closed. */
  function bindingOf(policy: Policy, admission: Admission): readonly string[] | null {
    try {
      return peerBinding(policy, admission);
    } catch {
      return deny("policy_unavailable");
    }
  }

  const scopeOf = (context: RequestContext, action: WorkspaceAction | GlobalAction): string => {
    const record = recordFor(context, { action });
    return record.workspace!;
  };

  async function appendAudit(
    context: RequestContext,
    entry: {
      tool: string;
      input: unknown;
      status: "ok" | "error";
      result: unknown;
      duration_ms: number;
      session_name?: string | null;
      client_label?: string | null;
      /** A7/D8: the speaker the connection asserted (X-Arra-Peer), bound by R3. */
      peer_name?: string | null;
      /** D6: the alias the caller used, when `tool` is its canonical name. */
      requested_as?: string | null;
    },
  ): Promise<void> {
    const record = CONTEXTS.get(context as object);
    if (record === undefined) deny("invalid_request");
    await deps.logCall({
      ...entry,
      workspace_name: record.workspace,
      auth: {
        principal_id: record.principalId,
        credential_id: record.credentialId,
        policy_version: record.policyVersion,
      },
    });
  }

  /** #31 legacy-audit: an admitted legacy HTTP call writes the row its MCP twin
   *  (`tool`) writes, success or failure, through the same `appendAudit`. The
   *  global maintenance routes are not audited: no twin, no workspace for a row. */
  const auditHttp = <T>(context: RequestContext, tool: string, http: HttpAudit, input: () => unknown) =>
    (run: () => Promise<T>, present?: (value: T) => unknown) =>
      auditedHttpCall((entry) => appendAudit(context, entry), clock, { tool, http, input }, run, present);

  return Object.freeze({
    // ── HTTP entrypoints: credentials in, results out ───────────────────────
    /**
     * `afterAdmit` validates NON-SCOPE parameters and runs only once admission
     * has succeeded. Checking them earlier leaked malformed-parameter 400s to
     * unauthenticated callers, who should see 401 and learn nothing else.
     */
    async listMemories(
      authorization: string | null,
      workspace: string,
      limit: number,
      afterAdmit: () => Error | null = () => null,
      http: HttpAudit = {},
    ) {
      const context = admitWorkspace(authorization, workspace, "content:read");
      return auditHttp<unknown[]>(context, "list_memories", http, () => ({ limit }))(async () => {
        const invalid = afterAdmit();
        if (invalid !== null) throw invalid;
        return deps.list(scopeOf(context, "content:read"), limit, {});
      });
    },

    async searchMemories(
      authorization: string | null,
      workspace: string,
      q: string,
      mode: "text" | "vector",
      limit: number,
      afterAdmit: () => Error | null = () => null,
      http: HttpAudit = {},
    ): Promise<{ match?: TextSearchResult["match"]; rows: unknown[] }> {
      const context = admitWorkspace(authorization, workspace, "content:read");
      type Found = { match?: TextSearchResult["match"]; rows: unknown[] };
      return auditHttp<Found>(context, "recall", http, () => ({ query: q, mode, limit }))(async () => {
        const invalid = afterAdmit();
        if (invalid !== null) throw invalid;
        const bank = scopeOf(context, "content:read");
        // Vector mode has no lexical match mode to report; text mode always does.
        return mode === "vector" ? { rows: await deps.searchVector(q, bank, limit) } : deps.searchText(q, bank, limit);
      }, (found) => searchAnswer(mode, found));
    },

    async diagnostics(authorization: string | null, workspace: string, http: HttpAudit = {}) {
      const context = admitWorkspace(authorization, workspace, "diagnostics:read");
      return auditHttp<unknown>(context, "bank_info", http, () => ({}))(async () => {
        const bank = scopeOf(context, "diagnostics:read");
        const health = await deps.embedHealth();
        // Readiness only: never the model address or raw failure detail.
        return { db: await deps.stats(bank), embedder: { ok: health.ok, dims: health.dims } };
      });
    },

    /**
     * Admit content:write ONCE, then build the row.
     *
     * `buildRow` runs only after admission, so a denied caller triggers no
     * storage read and no field-level error. An earlier version probed with a
     * list call first: that admitted the WRONG action (content:read), touched
     * storage for a request that might be refused, and sampled the clock twice.
     */
    async insertMemory(
      authorization: string | null,
      workspace: string,
      buildRow: () => {
        name: string;
        content: string;
        type?: string;
        session_name?: string;
        peer_name?: string;
        subject_peer_name?: string;
      } | null,
      http: HttpAudit = {},
    ) {
      const policy = snapshot();
      const admission = admitOrDeny(policy, authorization, clock(), { kind: "workspace", workspace, action: "content:write" });
      const context = contextFrom(admission);
      return auditHttp<{ id: string; embedded: boolean }>(context, "remember", http, () => ({}))(async () => {
        const row = buildRow();
        if (row === null) deny("invalid_request");
        // #87 / R3: the row's author is caller-asserted, so the grant's `peers`
        // binding, read from the SAME snapshot, bounds it.
        if (!isBoundAuthor(row, bindingOf(policy, admission))) deny("forbidden");
        // Scope comes from the ADMITTED context, never from the caller's payload.
        return deps.insert({ ...row, workspace_name: scopeOf(context, "content:write") });
      });
    },

    async backfill(
      authorization: string | null,
      batch: number,
      beforeMutate: () => Promise<void> = async () => {},
    ) {
      const admit = () => principalOf(admitGlobal(authorization, "maintenance:backfill"));
      const mutate = async () => (await beforeMutate(), deps.backfill(batch));
      return withInstanceAudit(logInstanceAudit, "/api/backfill", "maintenance:backfill", { batch }, admit, mutate);
    },

    async reindex(authorization: string | null, beforeMutate: () => Promise<void> = async () => {}) {
      const admit = () => principalOf(admitGlobal(authorization, "maintenance:reindex"));
      const mutate = async () => {
        await beforeMutate();
        return deps.ensureFtsIndex(true);
      };
      return withInstanceAudit(logInstanceAudit, "/api/reindex", "maintenance:reindex", {}, admit, mutate);
    },

    /**
     * MCP: project the four actions FIRST, then let the caller read the body
     * lazily, then dispatch. The adapter never receives a context — it hands in
     * a reader and gets a result back.
     */
    async runMcp(
      authorization: string | null,
      workspace: string,
      readEnvelope: () => Promise<McpEnvelope | null>,
      dispatch: (tool: string, args: Record<string, unknown>, ops: ToolOperations) => Promise<unknown>,
      userAgent = "",
      headerPeer: string | null = null,
    ): Promise<McpResult> {
      const v3Compat = config.v3Compat === true;
      // A7/D8 (R18): the speaker assertion belongs to the v3 family. With the
      // flag off it is dropped here as well as in app.ts, so no binding check,
      // no ops.assertedPeer and no audit peer_name: base behavior.
      const assertedPeer = v3Compat ? headerPeer : null;
      // One snapshot and one clock value for the entire projection.
      //
      // snapshot() throws on a missing or malformed policy. Letting that escape
      // produced a bare HTTP 500 with no Cache-Control instead of the fixed 503
      // JSON, so it is mapped onto the denial path here like every other
      // failure. Still no last-good fallback.
      let policy: Policy;
      try {
        policy = snapshot();
      } catch {
        return { kind: "denied", code: "policy_unavailable" };
      }
      const now = clock();
      const granted = new Map<WorkspaceAction, RequestContext>();
      let firstAdmission: Admission | null = null;
      let sawUnauthenticated = false;
      let sawForbidden = false;
      for (const action of MCP_ACTION_ORDER) {
        try {
          const admission = admitOrDeny(policy, authorization, now, { kind: "workspace", workspace, action });
          firstAdmission ??= admission;
          granted.set(action, contextFrom(admission));
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "unauthenticated") sawUnauthenticated = true;
          else if (code === "forbidden") sawForbidden = true;
          else return { kind: "denied", code: "policy_unavailable" };
        }
      }
      if (granted.size === 0) {
        if (sawUnauthenticated && sawForbidden) return { kind: "denied", code: "policy_unavailable" };
        return { kind: "denied", code: sawUnauthenticated ? "unauthenticated" : "forbidden" };
      }
      // #87 / R3, from this SAME snapshot: the audit:read operator view and
      // the grant's `peers` binding (one principal, one workspace grant, so
      // it is the same whichever of the four actions admitted first).
      let authority: RequestAuthority;
      try {
        authority = Object.freeze({ operator: granted.has("audit:read"), peers: bindingOf(policy, firstAdmission!) });
      } catch {
        return { kind: "denied", code: "policy_unavailable" };
      }
      // A7/D8 (R18): X-Arra-Peer is a caller ASSERTION about who speaks on this
      // connection. Under a `peers` binding it must be listed, from the same
      // snapshot; refused like any other forbidden request, before the body.
      if (assertedPeer !== null && authority.peers !== null && !authority.peers.includes(assertedPeer)) {
        return { kind: "denied", code: "forbidden" };
      }

      // Only now is the body read: an unadmitted caller never gets this far.
      const envelope = await readEnvelope();
      if (envelope === null) return { kind: "tool_error", message: "parse error" };

      // Exact grants: a tool's `toolAlsoNeeds` actions must be held too, from this snapshot.
      const holdsAlso = (tool: string) => toolAlsoNeeds(tool, v3Compat).every((also) => granted.has(also));
      if (envelope.method === "tools/list") {
        const names: string[] = [];
        for (const tool of v3Compat ? [...TOOL_NAMES, ...V3_TOOL_NAMES] : TOOL_NAMES) {
          const action = toolAction(tool, v3Compat);
          if (action !== undefined && granted.has(action) && holdsAlso(tool)) names.push(tool);
        }
        return { kind: "tools", names };
      }
      if (envelope.method !== "tools/call") return { kind: "method_not_found" };

      const requested = envelope.params.name;
      if (typeof requested !== "string" || !requested.trim()) {
        return { kind: "tool_error", message: "name must be a non-blank string" };
      }
      // D6: an `arra_*` alias becomes its canonical name BEFORE the action
      // lookup, so it runs under that tool's own action and is audited as it.
      const { canonical: name, requestedAs } = resolveToolName(requested, v3Compat);
      const action = toolAction(name, v3Compat);
      const context = action === undefined ? undefined : granted.get(action);
      // Unknown tool and unpermitted tool are indistinguishable, and neither
      // echoes the caller-supplied name back; nor does one whose `holdsAlso` fails.
      if (context === undefined || !holdsAlso(name)) return { kind: "denied", code: "forbidden" };

      const bank = scopeOf(context, action!);
      const started = clock();

      const suppliedArgs = envelope.params.arguments ?? {};
      if (!suppliedArgs || typeof suppliedArgs !== "object" || Array.isArray(suppliedArgs)) {
        // The call WAS admitted for its action, so this failure is an audited
        // operation outcome, not a discovery or permission denial.
        const message = "arguments must be an object";
        await appendAudit(context, {
          tool: name,
          input: suppliedArgs,
          status: "error",
          result: message,
          duration_ms: clock() - started,
          session_name: null,
          client_label: userAgent || null,
          peer_name: assertedPeer,
          requested_as: requestedAs,
        });
        return { kind: "tool_error", message };
      }
      const args = suppliedArgs as Record<string, unknown>;

      // Operations bound to the admitted context, and to THIS REQUEST.
      //
      // Two separate guards, because each closes a different hole:
      //  - the action check stops a read-admitted dispatcher calling insert;
      //  - the liveness flag stops a dispatcher STASHING ops and using it after
      //    the request finished, when the credential may since have been
      //    revoked. A captured capability that outlives its request is
      //    authority that no longer answers to the policy.
      let live = true;
      const requires = (needed: WorkspaceAction) => {
        if (!live) deny("invalid_request");
        recordFor(context, { action: needed, workspace });
      };
      const ops: ToolOperations = bindToolOperations({ bank, authority, assertedPeer, deps, requires, deny });

      try {
        const value = await dispatch(name, args, ops);
        await appendAudit(context, {
          tool: name,
          input: args,
          status: "ok",
          result: value,
          duration_ms: clock() - started,
          session_name: typeof args.session_name === "string" ? args.session_name : null,
          client_label: userAgent || null,
          peer_name: assertedPeer,
          requested_as: requestedAs,
        });
        return { kind: "ok", value };
      } catch (error) {
        // #31: a governed envelope error (arra-error/v1, arra-publication-
        // error/v1, arra-taxonomy-error/v1) must cross this transport
        // UNCHANGED, same as HTTP. This is the one MCP exit every tool result
        // funnels through, so the exact JSON is carried in `message` here
        // rather than collapsed to `.message` text; `text()` on the MCP side
        // passes a string value through untouched.
        const message = auditErrorText(error);
        await appendAudit(context, {
          tool: name,
          input: args,
          status: "error",
          result: message,
          duration_ms: clock() - started,
          session_name: typeof args.session_name === "string" ? args.session_name : null,
          client_label: userAgent || null,
          peer_name: assertedPeer,
          requested_as: requestedAs,
        });
        return { kind: "tool_error", message };
      } finally {
        // Every path, success or failure: the capability dies with the request.
        live = false;
      }
    },
  });
}
