import type { ToolOperations } from "../auth/service.createOperationService";
import { AuthDenied } from "../auth/service.AuthDenied";
import { isBoundAuthor } from "../auth/service.isBoundAuthor";
import { KNOWLEDGE_METHODS } from "../knowledge/registry";
import { bodyScopeRefusal } from "../knowledge/transport.bodyScopeRefusal";
import { payloadRefusal } from "../knowledge/transport.payloadRefusal";
import { callKnowledgeMethod } from "./index.callKnowledgeMethod";
import { knowledgeAccessState } from "./index.state";
import { V3_TOOL_NAMES } from "./legacy-v3/catalogue";
import { validateType } from "./remember.validateType";
import { dispatchLegacyV3 } from "./legacy-v3/dispatchLegacyV3";
import { SERVER_NAME, SERVER_VERSION } from "./protocol";
import { TOOLS } from "./tools";

// The tool -> action map is the service's (`auth/service.toolAction.ts`). A
// second, hand-kept copy used to sit here with no callers and no kb_ entries
// (parity defect 6); it is gone so nothing can grow a third one by mistake.

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
 * four-action MCP projection in `auth/service.createOperationService.ts` ran before `dispatchTool`
 * was ever called). The payload's own `workspace_name` is checked against it
 * for the same reason the HTTP transport checks its route `:bank`: a name
 * inside the request is not itself authorization. `payload` is re-encoded to
 * bytes with a plain `JSON.stringify` — safe here specifically because it was
 * already decoded ONCE by this package's own governed strict parser (the
 * `/mcp/:bank` envelope reader in `app.createApp.ts`), so no duplicate key or invalid
 * UTF-8 could have survived to reach this point; this is not a second
 * ungoverned parser, it is a lossless re-encode of an already-validated value.
 */
async function dispatchKnowledgeTool(name: string, args: Record<string, unknown>, ops: ToolOperations): Promise<unknown> {
  const method = name.slice(3);
  const entry = KNOWLEDGE_METHODS[method];
  if (entry === undefined) throw new Error("unknown tool");
  const payload = args.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw payloadRefusal(payload);
  }
  const scoped = readWorkspaceAtPlain(payload, entry.scopePath);
  if (scoped === null || scoped !== ops.bank) throw bodyScopeRefusal();
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  // Peer binding, the operations-root branch and bundle choice live in the
  // one helper the v3 adapter's kb() shares.
  return callKnowledgeMethod(knowledgeAccessState.current, method, bytes, ops.authority);
}

/** Pure dispatcher: receives scope-bound operations, never a context. */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ops: ToolOperations,
): Promise<unknown> {
  // R18: the v3 family (the service only admits these names with
  // ARRA_MCP_V3_COMPAT on). It refuses scope AND tenant carriers itself,
  // with the arra-v3-compat/1 body v3 clients can read.
  if (V3_TOOL_NAMES.includes(name)) return dispatchLegacyV3(name, args, ops, knowledgeAccessState.current);

  for (const carrier of SCOPE_CARRIERS) {
    if (carrier in args) throw new Error("scope may not be supplied in arguments");
  }

  if (name.startsWith("kb_")) return dispatchKnowledgeTool(name, args, ops);

  switch (name) {
    case "remember": {
      const content = requiredString(args, "content");
      // #87 / R3 precedence, unchanged: the peer-binding refusal (`forbidden`)
      // must still win over a taxonomy refusal, exactly as it wins over the
      // store write `ops.insert` performs below -- so it is checked here
      // FIRST, before the (possibly slower, kernel-reaching) taxonomy call.
      // `ops.insert` re-checks it too; that second check is cheap and keeps
      // this file from being the only place trusted with the rule.
      const peerName = optionalString(args, "peer_name");
      if (!isBoundAuthor({ peer_name: peerName }, ops.authority.peers)) throw new AuthDenied("forbidden");
      // D5a: the same sealed `type` vocabulary a knowledge-transport publish
      // enforces, now enforced here too (`remember.validateType.ts`).
      const type = await validateType(knowledgeAccessState.current, ops.bank, ops.authority, optionalString(args, "type"));
      const res = await ops.insert({
        name: optionalString(args, "name") ?? content.slice(0, 48).replace(/\s+/g, "-").toLowerCase(),
        content,
        type,
        session_name: optionalString(args, "session_name"),
        peer_name: peerName,
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
      // The same answer shape as GET /api/search, so a caller can see HOW a text
      // answer was produced (R14): `match` is "ngram" or, under 3 code points,
      // "substring_scan". Vector mode has no lexical match mode.
      if (mode === "vector") {
        const rows = await ops.searchVector(q, limit);
        return { mode, count: rows.length, rows };
      }
      const { match, rows } = await ops.searchText(q, limit);
      return { mode, match, count: rows.length, rows };
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
        // R32 (Nat 2026-09-28, #135): target-19 is the default migration and
        // the manifest says `active`. The legacy 15 are still created, behind
        // `--legacy-active15`, for the legacy memories routes.
        contract: {
          manifest: "arra-v4-target/1",
          status: "active",
          active_tables: 19,
          target_tables: 19,
          legacy_tables: 15,
        },
      };
    }
    default:
      throw new Error("unknown tool");
  }
}
