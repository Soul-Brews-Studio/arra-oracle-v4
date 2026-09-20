// MCP dispatch. One stateless POST, per bank: /mcp/:bank
//
// Bank FIRST — it is the tenant (§3.1). A connector is scoped to one bank at
// registration, so a model cannot address a bank it was not given. The old
// extra workspace path is rejected at the HTTP boundary because it had no
// implemented semantics.

import * as store from "../db";
import * as embed from "../embed";
import { storageInfo } from "../storage";
import * as calls from "./calls";
import { JsonRpcRequest, SERVER_NAME, SERVER_VERSION, err, negotiate, ok, text } from "./protocol";
import { TOOLS } from "./tools";

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

async function runTool(name: string, args: Record<string, any>, bank: string): Promise<unknown> {
  switch (name) {
    case "remember": {
      const content = requiredString(args, "content");
      const res = await store.insert({
        name: optionalString(args, "name") ?? content.slice(0, 48).replace(/\s+/g, "-").toLowerCase(),
        content,
        type: optionalString(args, "type"),
        workspace_name: bank,
        session_name: optionalString(args, "session_name"),
        peer_name: optionalString(args, "peer_name"),
        subject_peer_name: optionalString(args, "subject_peer_name"),
      });
      // Say which happened. "embedded: false" is not a failure — it is §4.6's
      // write path working, and the caller should not read it as one.
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
      return mode === "vector"
        ? await store.searchVector(q, bank, limit)
        : await store.searchText(q, bank, limit);
    }
    case "get_memory": {
      const id = requiredString(args, "id");
      const hit = await store.getById(bank, id);
      if (!hit) throw new Error(`no memory '${id}' in bank '${bank}'`);
      return hit;
    }
    case "list_memories": {
      const syncState = optionalString(args, "sync_state");
      if (syncState !== undefined && !["pending", "synced", "failed"].includes(syncState)) {
        throw new Error("sync_state must be 'pending', 'synced', or 'failed'");
      }
      return store.list(bank, bounded(args.limit, 20, "limit"), {
        type: optionalString(args, "type"),
        session_name: optionalString(args, "session_name"),
        peer_name: optionalString(args, "peer_name"),
        subject_peer_name: optionalString(args, "subject_peer_name"),
        sync_state: syncState,
        is_active: args.is_active === undefined
          ? undefined
          : typeof args.is_active === "boolean"
            ? args.is_active
            : (() => { throw new Error("is_active must be a boolean"); })(),
      });
    }
    case "bank_info": {
      const s = await store.stats(bank);
      const e = await embed.health();
      return {
        bank,
        ...s,
        embedder: { model: e.model, dims: e.dims, ok: e.ok },
        storage: storageInfo(),
        // §4.6.1: the operator must be able to SEE the consistency gap, or
        // nobody fixes it.
        gaps: { unembedded: s.unembedded ?? 0 },
      };
    }
    case "call_log":
      const status = optionalString(args, "status");
      if (status !== undefined && status !== "ok" && status !== "error") {
        throw new Error("status must be 'ok' or 'error'");
      }
      return await calls.recent(bank, bounded(args.limit, 20, "limit"), status);
    case "call_stats":
      return await calls.aggregate(bank);
    case "status": {
      const e = await embed.health();
      return {
        server: `${SERVER_NAME} ${SERVER_VERSION}`,
        storage: storageInfo(),
        // §6.4 — name the doors rather than saying "ok". Auth is not built yet
        // and this says so, instead of implying a gate that does not exist.
        auth: ["none — SPEC §7 not implemented"],
        embedder: e.ok ? `${e.model} (${e.dims}d)` : `DOWN: ${e.detail}`,
        tools: TOOLS.length,
        contract: {
          manifest: "arra-v4-target/1",
          status: "proposed-not-active",
          active_tables: 15,
          target_tables: 19,
          note: "target manifest is validated in the schema project; runtime still serves the active memory spike",
        },
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function handleMcp(body: unknown, bank: string, userAgent = ""): Promise<Response> {
  const rpc = (body ?? {}) as JsonRpcRequest;
  if (!rpc || typeof rpc !== "object" || typeof rpc.method !== "string") {
    return Response.json(err(null, -32700, "parse error"), { status: 400 });
  }
  if (!bank?.trim()) {
    return Response.json(err(rpc.id ?? null, -32602, "bank is required"), { status: 400 });
  }

  const id = rpc.id ?? null;
  const rawParams = rpc.params ?? {};
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return Response.json(err(rpc.id ?? null, -32602, "params must be an object"), { status: 400 });
  }
  const params = rawParams as Record<string, any>;

  switch (rpc.method) {
    case "initialize":
      return Response.json(
        ok(id, {
          protocolVersion: negotiate(params.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      );

    // Notifications carry no id and expect no body.
    case "notifications/initialized":
    case "initialized":
      return new Response(null, { status: 202 });

    case "ping":
      return Response.json(ok(id, {}));

    case "tools/list":
      return Response.json(ok(id, { tools: TOOLS }));

    case "tools/call": {
      const started = Date.now();
      if (typeof params.name !== "string" || !params.name.trim()) {
        const message = "name must be a non-blank string";
        await calls.logCall({
          tool: "<invalid>", input: params, status: "error", result: message,
          duration_ms: Date.now() - started, workspace_name: bank, peer_name: null,
          client_label: userAgent || null,
        });
        return Response.json(ok(id, { ...text(message), isError: true }));
      }
      const name = params.name;
      const suppliedArgs = params.arguments ?? {};
      if (!suppliedArgs || typeof suppliedArgs !== "object" || Array.isArray(suppliedArgs)) {
        const message = "arguments must be an object";
        await calls.logCall({
          tool: name, input: suppliedArgs, status: "error", result: message,
          duration_ms: Date.now() - started, workspace_name: bank, peer_name: null,
          client_label: userAgent || null,
        });
        return Response.json(ok(id, { ...text(message), isError: true }));
      }
      const args = suppliedArgs as Record<string, any>;
      try {
        const result = await runTool(name, args, bank);
        await calls.logCall({
          tool: name, input: args, status: "ok", result,
          duration_ms: Date.now() - started, workspace_name: bank, peer_name: null,
          session_name: typeof args.session_name === "string" ? args.session_name : null,
          client_label: userAgent || null,
        });
        return Response.json(ok(id, text(result)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await calls.logCall({
          tool: name, input: args, status: "error", result: message,
          duration_ms: Date.now() - started, workspace_name: bank, peer_name: null,
          session_name: typeof args.session_name === "string" ? args.session_name : null,
          client_label: userAgent || null,
        });
        // isError keeps the failure inside the TOOL RESULT, which is where an
        // MCP client shows it to the model. A JSON-RPC error would be a
        // transport fault instead, and the model would never see the reason.
        return Response.json(ok(id, { ...text(message), isError: true }));
      }
    }

    default:
      return Response.json(err(id, -32601, `method not found: ${rpc.method}`));
  }
}
