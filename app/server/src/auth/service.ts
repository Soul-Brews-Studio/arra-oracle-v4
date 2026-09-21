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
import { loadPolicy } from "./loader";
import { TOOL_NAMES } from "../mcp/tools";
import { KNOWLEDGE_METHODS } from "../knowledge/registry";

export type AuthFailure = "unauthenticated" | "forbidden" | "policy_unavailable" | "invalid_request";

export class AuthDenied extends Error {
  readonly code!: AuthFailure;

  constructor(code: AuthFailure) {
    super(code);
    this.name = "AuthDenied";
    Object.defineProperty(this, "code", {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}

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

/**
 * The authoritative tool -> action map.
 *
 * Owned HERE, not supplied by a caller: letting an adapter choose which action
 * a tool required would let it pick the cheapest grant it happened to hold.
 */
const MEMORY_TOOL_ACTION: Readonly<Record<string, WorkspaceAction>> = {
  remember: "content:write",
  recall: "content:read",
  get_memory: "content:read",
  list_memories: "content:read",
  bank_info: "diagnostics:read",
  status: "diagnostics:read",
  call_log: "audit:read",
  call_stats: "audit:read",
};

/** #31: `kb_<method>` -> the same action `knowledge/registry.ts` declares.
 *  Data-driven so a new registry entry is admitted/listed automatically. */
const KNOWLEDGE_TOOL_ACTION: Readonly<Record<string, WorkspaceAction>> = Object.fromEntries(
  Object.entries(KNOWLEDGE_METHODS).map(([method, entry]) => [`kb_${method}`, entry.action]),
);

const TOOL_ACTION: Readonly<Record<string, WorkspaceAction>> = Object.freeze({
  ...MEMORY_TOOL_ACTION,
  ...KNOWLEDGE_TOOL_ACTION,
});

export type StoreDependencies = {
  insert(row: {
    workspace_name: string;
    name: string;
    content: string;
    type?: string;
    session_name?: string;
    peer_name?: string;
    subject_peer_name?: string;
  }): Promise<{ id: string; embedded: boolean }>;
  list(bank: string, limit: number, filters?: Record<string, unknown>): Promise<unknown[]>;
  searchText(q: string, bank: string, limit: number): Promise<unknown[]>;
  searchVector(q: string, bank: string, limit: number): Promise<unknown[]>;
  getById(bank: string, id: string): Promise<unknown>;
  stats(bank: string): Promise<Record<string, unknown>>;
  backfill(batch: number): Promise<unknown>;
  ensureFtsIndex(replace?: boolean): Promise<string[]>;
  embedHealth(): Promise<{ ok: boolean; model: string; dims: number; detail: string }>;
  recentCalls(bank: string, limit: number, status?: string): Promise<unknown[]>;
  aggregateCalls(bank: string): Promise<unknown>;
  logCall(record: Record<string, unknown>): Promise<void>;
};

export type ServiceConfig = { readonly policyPath: string };
export type Clock = () => number;

/** What an MCP adapter may ask the service to do, once projection succeeded. */
export type McpEnvelope = {
  readonly method: string;
  readonly id: string | number | null;
  readonly params: Record<string, unknown>;
};

export type McpResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "tool_error"; readonly message: string }
  | { readonly kind: "denied"; readonly code: AuthFailure }
  | { readonly kind: "tools"; readonly names: readonly string[] }
  | { readonly kind: "method_not_found" };

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
    ) {
      const context = admitWorkspace(authorization, workspace, "content:read");
      const invalid = afterAdmit();
      if (invalid !== null) throw invalid;
      return deps.list(scopeOf(context, "content:read"), limit, {});
    },

    async searchMemories(
      authorization: string | null,
      workspace: string,
      q: string,
      mode: "text" | "vector",
      limit: number,
      afterAdmit: () => Error | null = () => null,
    ) {
      const context = admitWorkspace(authorization, workspace, "content:read");
      const invalid = afterAdmit();
      if (invalid !== null) throw invalid;
      const bank = scopeOf(context, "content:read");
      return mode === "vector" ? deps.searchVector(q, bank, limit) : deps.searchText(q, bank, limit);
    },

    async diagnostics(authorization: string | null, workspace: string) {
      const context = admitWorkspace(authorization, workspace, "diagnostics:read");
      const bank = scopeOf(context, "diagnostics:read");
      const health = await deps.embedHealth();
      // Readiness only: never the model address or raw failure detail.
      return { db: await deps.stats(bank), embedder: { ok: health.ok, dims: health.dims } };
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
    ) {
      const context = admitWorkspace(authorization, workspace, "content:write");
      const row = buildRow();
      if (row === null) deny("invalid_request");
      // Scope comes from the ADMITTED context, never from the caller's payload.
      return deps.insert({ ...row, workspace_name: scopeOf(context, "content:write") });
    },

    /**
     * Admit the global grant FIRST, then run `beforeMutate`, then mutate.
     *
     * `beforeMutate` is where the route applies its bounded encoding/body
     * rules. Ordering matters twice over: an unadmitted caller's body is never
     * read, and an admitted caller still cannot skip the transport caps just
     * because the grant is global.
     */
    async backfill(
      authorization: string | null,
      batch: number,
      beforeMutate: () => Promise<void> = async () => {},
    ) {
      admitGlobal(authorization, "maintenance:backfill");
      await beforeMutate();
      return deps.backfill(batch);
    },

    async reindex(authorization: string | null, beforeMutate: () => Promise<void> = async () => {}) {
      admitGlobal(authorization, "maintenance:reindex");
      await beforeMutate();
      return deps.ensureFtsIndex(true);
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
    ): Promise<McpResult> {
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
      let sawUnauthenticated = false;
      let sawForbidden = false;
      for (const action of MCP_ACTION_ORDER) {
        try {
          granted.set(
            action,
            contextFrom(admitOrDeny(policy, authorization, now, { kind: "workspace", workspace, action })),
          );
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

      // Only now is the body read: an unadmitted caller never gets this far.
      const envelope = await readEnvelope();
      if (envelope === null) return { kind: "tool_error", message: "parse error" };

      if (envelope.method === "tools/list") {
        const names: string[] = [];
        for (const tool of TOOL_NAMES) {
          const action = TOOL_ACTION[tool];
          if (action !== undefined && granted.has(action)) names.push(tool);
        }
        return { kind: "tools", names };
      }
      if (envelope.method !== "tools/call") return { kind: "method_not_found" };

      const name = envelope.params.name;
      if (typeof name !== "string" || !name.trim()) {
        return { kind: "tool_error", message: "name must be a non-blank string" };
      }
      const action = TOOL_ACTION[name];
      const context = action === undefined ? undefined : granted.get(action);
      // Unknown tool and unpermitted tool are indistinguishable, and neither
      // echoes the caller-supplied name back.
      if (context === undefined) return { kind: "denied", code: "forbidden" };

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
      const ops: ToolOperations = Object.freeze({
        bank,
        insert: (row) => {
          requires("content:write");
          return deps.insert({ ...row, workspace_name: bank });
        },
        list: (limit, filters) => {
          requires("content:read");
          return deps.list(bank, limit, filters);
        },
        searchText: (q, limit) => {
          requires("content:read");
          return deps.searchText(q, bank, limit);
        },
        searchVector: (q, limit) => {
          requires("content:read");
          return deps.searchVector(q, bank, limit);
        },
        getById: (id) => {
          requires("content:read");
          return deps.getById(bank, id);
        },
        stats: () => {
          requires("diagnostics:read");
          return deps.stats(bank);
        },
        embedReadiness: async () => {
          requires("diagnostics:read");
          const health = await deps.embedHealth();
          return { ok: health.ok, dims: health.dims };
        },
        recentCalls: (limit, status) => {
          requires("audit:read");
          return deps.recentCalls(bank, limit, status);
        },
        aggregateCalls: () => {
          requires("audit:read");
          return deps.aggregateCalls(bank);
        },
      });

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
        });
        return { kind: "ok", value };
      } catch (error) {
        // #31: a governed envelope error (arra-error/v1, arra-publication-
        // error/v1, arra-taxonomy-error/v1) must cross this transport
        // UNCHANGED, same as HTTP. This is the one MCP exit every tool result
        // funnels through, so the exact JSON is carried in `message` here
        // rather than collapsed to `.message` text; `text()` on the MCP side
        // passes a string value through untouched.
        const envelope =
          typeof error === "object" &&
          error !== null &&
          typeof (error as { code?: unknown }).code === "string" &&
          typeof (error as { path?: unknown }).path === "string" &&
          typeof (error as { toJSON?: unknown }).toJSON === "function"
            ? JSON.stringify((error as { toJSON(): unknown }).toJSON())
            : null;
        const message = envelope ?? (error instanceof Error ? error.message : String(error));
        await appendAudit(context, {
          tool: name,
          input: args,
          status: "error",
          result: message,
          duration_ms: clock() - started,
          session_name: typeof args.session_name === "string" ? args.session_name : null,
          client_label: userAgent || null,
        });
        return { kind: "tool_error", message };
      } finally {
        // Every path, success or failure: the capability dies with the request.
        live = false;
      }
    },
  });
}

/**
 * Scope-bound operations handed to a tool dispatcher.
 *
 * These ARE authority — a callable operation can reach the store. It is bounded
 * two ways: each method re-checks the admitted action, and the whole set is
 * invalidated when the request that produced it ends.
 */
export type ToolOperations = {
  readonly bank: string;
  insert(row: {
    name: string;
    content: string;
    type?: string;
    session_name?: string;
    peer_name?: string;
    subject_peer_name?: string;
  }): Promise<{ id: string; embedded: boolean }>;
  list(limit: number, filters: Record<string, unknown>): Promise<unknown[]>;
  searchText(q: string, limit: number): Promise<unknown[]>;
  searchVector(q: string, limit: number): Promise<unknown[]>;
  getById(id: string): Promise<unknown>;
  stats(): Promise<Record<string, unknown>>;
  embedReadiness(): Promise<{ ok: boolean; dims: number }>;
  recentCalls(limit: number, status?: string): Promise<unknown[]>;
  aggregateCalls(): Promise<unknown>;
};
