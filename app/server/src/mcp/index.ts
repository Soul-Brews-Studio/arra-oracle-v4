/**
 * MCP adapter (`authorization-integration-v1.md` §1, §3).
 *
 * This module maps JSON-RPC envelopes onto the operation service and shapes the
 * replies. It never receives a gate, an Admission or a request context, and it
 * does not choose which action a tool needs -- the service owns that map.
 *
 * It is NOT authority-free, and the earlier comment claiming so was wrong: the
 * dispatcher below receives scope-bound callable operations, and a callable
 * operation IS authority. What bounds it is enforced on the service side --
 * each operation re-checks the admitted action, and the whole set is
 * invalidated when the request ends.
 */

import type { WorkspaceAction } from "../auth/policy";
import type { McpEnvelope, OperationService, ToolOperations } from "../auth/service";
import { KNOWLEDGE_METHODS } from "../knowledge/registry";
import type { KnowledgeAccess } from "../knowledge/transport";
import { requireBoundPeers } from "../knowledge/transport.requireBoundPeers";
import { SERVER_NAME, SERVER_VERSION, err, negotiate, ok, text } from "./protocol";
import { TOOLS } from "./tools";

/** Which action each tool needs. A tool absent here is not dispatchable. */
const TOOL_ACTION: Readonly<Record<string, WorkspaceAction>> = Object.freeze({
  remember: "content:write",
  recall: "content:read",
  get_memory: "content:read",
  list_memories: "content:read",
  bank_info: "diagnostics:read",
  status: "diagnostics:read",
  call_log: "audit:read",
  call_stats: "audit:read",
});

export const toolAction = (tool: string): WorkspaceAction | undefined => TOOL_ACTION[tool];

const optionalString = (args: Record<string, unknown>, field: string) => {
  if (!(field in args)) return undefined;
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-blank string`);
  return value;
};

const requiredString = (args: Record<string, unknown>, field: string) => {
  const value = optionalString(args, field);
  if (value === undefined) throw new Error(`${field} is required`);
  return value;
};

const bounded = (value: unknown, fallback: number, field: string) => {
  const number = value === undefined ? fallback : value;
  if (typeof number !== "number") throw new Error(`${field} must be a number`);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1000) {
    throw new Error(`${field} must be a safe integer between 1 and 1000`);
  }
  return number;
};

/** Scope may never travel in arguments: the route workspace is authoritative. */
const SCOPE_CARRIERS = ["workspace_name", "bank", "workspace"] as const;

/**
 * #31: where the connected `KnowledgeAccess` (opened by `composition.ts`)
 * lives for MCP dispatch. Set once at startup; unset means every `kb_*` tool
 * fails closed with a tool error rather than silently pretending to work.
 */
let knowledgeAccess: KnowledgeAccess | null = null;

export function configureKnowledgeAccess(access: KnowledgeAccess | null): void {
  knowledgeAccess = access;
}

/** Read `workspace_name` out of an ALREADY-DECODED plain object at `tokens`. */
function readWorkspaceAtPlain(value: unknown, tokens: readonly string[]): string | null {
  let node = value;
  for (const token of tokens) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
    node = (node as Record<string, unknown>)[token];
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
  const workspace = (node as Record<string, unknown>).workspace_name;
  return typeof workspace === "string" ? workspace : null;
}

/**
 * Dispatch one `kb_<method>` tool call.
 *
 * `ops.bank` is the workspace THIS request was already admitted for (the
 * four-action MCP projection in `auth/service.ts` ran before `dispatchTool`
 * was ever called). The payload's own `workspace_name` is checked against it
 * for the same reason the HTTP transport checks its route `:bank`: a name
 * inside the request is not itself authorization. `payload` is re-encoded to
 * bytes with a plain `JSON.stringify` — safe here specifically because it was
 * already decoded ONCE by this package's own governed strict parser (the
 * `/mcp/:bank` envelope reader in `app.ts`), so no duplicate key or invalid
 * UTF-8 could have survived to reach this point; this is not a second
 * ungoverned parser, it is a lossless re-encode of an already-validated value.
 */
async function dispatchKnowledgeTool(name: string, args: Record<string, unknown>, ops: ToolOperations): Promise<unknown> {
  const method = name.slice(3);
  const entry = KNOWLEDGE_METHODS[method];
  if (entry === undefined) throw new Error("unknown tool");
  const payload = args.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("payload must be an object");
  }
  const scoped = readWorkspaceAtPlain(payload, entry.scopePath);
  if (scoped === null || scoped !== ops.bank) {
    throw new Error("payload workspace_name must match the connected bank");
  }
  if (knowledgeAccess === null) throw new Error("knowledge transport is not configured");
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  // #87 / R3: the same peer-binding refusal as HTTP, before any writer opens;
  // it throws the governed `forbidden` envelope, carried out unchanged.
  requireBoundPeers(method, bytes, ops.authority);
  // Same gate discipline as the HTTP transport (`knowledge/transport.ts`'s
  // `handleKnowledgeRequest`): an `ephemeralWrite` method (currently only
  // `answerChat`) must never share the process-lifetime cached writer, or
  // `kb_answerChat` would seize the exclusive dataset gate on its first MCP
  // call and hold it for the rest of the process -- a call that persists
  // nothing and, at this deployment, cannot even succeed.
  if (entry.ephemeralWrite === true) {
    if (knowledgeAccess.getEphemeralWriter === undefined) {
      throw new Error("knowledge transport cannot open an ephemeral writer");
    }
    const opened = await knowledgeAccess.getEphemeralWriter();
    try {
      return await entry.call(opened, bytes, ops.authority);
    } finally {
      await opened.close().catch(() => undefined);
    }
  }
  const bundle = await knowledgeAccess.getBundle(entry.action);
  return entry.call(bundle, bytes, ops.authority);
}

/** Pure dispatcher: receives scope-bound operations, never a context. */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ops: ToolOperations,
): Promise<unknown> {
  for (const carrier of SCOPE_CARRIERS) {
    if (carrier in args) throw new Error("scope may not be supplied in arguments");
  }

  if (name.startsWith("kb_")) return dispatchKnowledgeTool(name, args, ops);

  switch (name) {
    case "remember": {
      const content = requiredString(args, "content");
      const res = await ops.insert({
        name: optionalString(args, "name") ?? content.slice(0, 48).replace(/\s+/g, "-").toLowerCase(),
        content,
        type: optionalString(args, "type"),
        session_name: optionalString(args, "session_name"),
        peer_name: optionalString(args, "peer_name"),
        subject_peer_name: optionalString(args, "subject_peer_name"),
      });
      return {
        ...res,
        sync_state: res.embedded ? "synced" : "pending",
        note: res.embedded ? undefined : "row is durable; vector backfills later",
      };
    }
    case "recall": {
      const q = requiredString(args, "query");
      const limit = bounded(args.limit, 10, "limit");
      const mode = args.mode === undefined ? "text" : args.mode;
      if (mode !== "text" && mode !== "vector") throw new Error("mode must be 'text' or 'vector'");
      return mode === "vector" ? ops.searchVector(q, limit) : ops.searchText(q, limit);
    }
    case "get_memory": {
      const hit = await ops.getById(requiredString(args, "id"));
      // Never reveal whether the id exists in some other bank.
      if (!hit) throw new Error("no such memory in this bank");
      return hit;
    }
    case "list_memories": {
      const syncState = optionalString(args, "sync_state");
      if (syncState !== undefined && !["pending", "synced", "failed"].includes(syncState)) {
        throw new Error("sync_state must be 'pending', 'synced', or 'failed'");
      }
      return ops.list(bounded(args.limit, 20, "limit"), {
        type: optionalString(args, "type"),
        session_name: optionalString(args, "session_name"),
        peer_name: optionalString(args, "peer_name"),
        subject_peer_name: optionalString(args, "subject_peer_name"),
        sync_state: syncState,
        is_active:
          args.is_active === undefined
            ? undefined
            : typeof args.is_active === "boolean"
              ? args.is_active
              : (() => {
                  throw new Error("is_active must be a boolean");
                })(),
      });
    }
    case "bank_info": {
      const s = await ops.stats();
      const embedder = await ops.embedReadiness();
      // Sanitized: no storage URI, no model address, no other-bank counts.
      return { bank: ops.bank, rows: s.rows, embedded: s.embedded, unembedded: s.unembedded, embedder };
    }
    case "call_log": {
      const status = optionalString(args, "status");
      if (status !== undefined && status !== "ok" && status !== "error") {
        throw new Error("status must be 'ok' or 'error'");
      }
      return ops.recentCalls(bounded(args.limit, 20, "limit"), status);
    }
    case "call_stats":
      return ops.aggregateCalls();
    case "status": {
      const embedder = await ops.embedReadiness();
      return {
        server: `${SERVER_NAME} ${SERVER_VERSION}`,
        auth: ["bearer — policy-file authorization active"],
        embedder_ready: embedder.ok,
        tools: TOOLS.length,
        contract: {
          manifest: "arra-v4-target/1",
          status: "proposed-not-active",
          active_tables: 15,
          target_tables: 19,
        },
      };
    }
    default:
      throw new Error("unknown tool");
  }
}

export type McpOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "denied"; readonly code: string };

export function createMcpAdapter(service: OperationService) {
  return async function handle(
    bank: string,
    authorization: string | null,
    readEnvelope: () => Promise<McpEnvelope | null>,
    userAgent = "",
  ): Promise<McpOutcome> {
    if (!bank?.trim()) return { kind: "denied", code: "invalid_scope" };

    // Envelope id is only known after the body is read, which the service does
    // lazily AFTER projection; replies before that point carry a null id.
    let envelopeId: string | number | null = null;
    const capturingReader = async () => {
      const envelope = await readEnvelope();
      envelopeId = envelope?.id ?? null;
      return envelope;
    };

    // The tool -> action map is owned by the service; passing one from here
    // would let the adapter choose which grant a tool required.
    const result = await service.runMcp(authorization, bank, capturingReader, dispatchTool, userAgent);

    switch (result.kind) {
      case "denied":
        return { kind: "denied", code: result.code };
      case "tools": {
        // Catalogue ORDER preserved; only tools whose action was admitted.
        const visible = TOOLS.filter((tool) => result.names.includes(tool.name));
        return { kind: "response", response: Response.json(ok(envelopeId, { tools: visible })) };
      }
      case "method_not_found":
        return { kind: "response", response: Response.json(err(envelopeId, -32601, "method not found")) };
      case "tool_error":
        return {
          kind: "response",
          response: Response.json(ok(envelopeId, { ...text(result.message), isError: true })),
        };
      case "ok":
        return { kind: "response", response: Response.json(ok(envelopeId, text(result.value))) };
    }
  };
}

/** Envelope shaping for handshake methods, which need no tool authority. */
export function handshakeResponse(method: string, id: string | number | null, params: Record<string, unknown>) {
  if (method === "initialize") {
    return Response.json(
      ok(id, {
        protocolVersion: negotiate(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    );
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return new Response(null, { status: 202 });
  }
  if (method === "ping") return Response.json(ok(id, {}));
  return null;
}
