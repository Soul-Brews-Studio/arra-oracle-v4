// MCP dispatch. One stateless POST, per bank: /mcp/:bank[/:workspace]
//
// Bank FIRST — it is the tenant (§3.1). The workspace segment narrows the room,
// never the isolation. A connector is scoped to one bank at registration, so a
// model cannot address a bank it was not given.

import * as store from "../db";
import * as embed from "../embed";
import { storageInfo } from "../storage";
import * as calls from "./calls";
import { JsonRpcRequest, SERVER_NAME, SERVER_VERSION, err, negotiate, ok, text } from "./protocol";
import { TOOLS } from "./tools";

const nz = (v: unknown) => (typeof v === "string" && v.length ? v : undefined);

async function runTool(name: string, args: Record<string, any>, bank: string): Promise<unknown> {
  switch (name) {
    case "remember": {
      const content = nz(args.content);
      if (!content) throw new Error("content is required");
      const res = await store.insert({
        name: nz(args.name) ?? content.slice(0, 48).replace(/\s+/g, "-").toLowerCase(),
        content,
        type: nz(args.type),
        workspace_name: bank,
        session_name: nz(args.session_name),
        peer_name: nz(args.peer_name),
      } as any);
      // Say which happened. "embedded: false" is not a failure — it is §4.6's
      // write path working, and the caller should not read it as one.
      return {
        ...res,
        sync_state: res.embedded ? "synced" : "pending",
        note: res.embedded ? undefined : "row is durable; vector backfills later",
      };
    }
    case "recall": {
      const q = nz(args.query);
      if (!q) throw new Error("query is required");
      const limit = Number(args.limit ?? 10);
      return args.mode === "vector"
        ? await store.searchVector(q, bank, limit)
        : await store.searchText(q, bank, limit);
    }
    case "get_memory": {
      const id = nz(args.id);
      if (!id) throw new Error("id is required");
      const rows = await store.list(bank, 1000);
      const hit = rows.find((r: any) => r.id === id);
      if (!hit) throw new Error(`no memory '${id}' in bank '${bank}'`);
      return hit;
    }
    case "list_memories": {
      const rows = await store.list(bank, Number(args.limit ?? 20) * 4);
      const want = (k: string, v: unknown) => v === undefined || (rows as any)[k] === v;
      return rows
        .filter(
          (r: any) =>
            want("type", nz(args.type)) &&
            (nz(args.type) === undefined || r.type === args.type) &&
            (nz(args.session_name) === undefined || r.session_name === args.session_name) &&
            (nz(args.peer_name) === undefined || r.peer_name === args.peer_name) &&
            (nz(args.sync_state) === undefined || r.sync_state === args.sync_state),
        )
        .slice(0, Number(args.limit ?? 20));
    }
    case "bank_info": {
      const s = await store.stats();
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
      return await calls.recent(Number(args.limit ?? 20), nz(args.status));
    case "call_stats":
      return await calls.aggregate();
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

  const id = rpc.id ?? null;
  const params = (rpc.params ?? {}) as Record<string, any>;

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
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, any>;
      const started = Date.now();
      const peer = nz(params.clientInfo?.name) ?? nz(userAgent) ?? null;
      try {
        const result = await runTool(name, args, bank);
        await calls.logCall({
          tool: name, input: args, status: "ok", result,
          duration_ms: Date.now() - started, workspace_name: bank, peer_name: peer,
        });
        return Response.json(ok(id, text(result)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await calls.logCall({
          tool: name, input: args, status: "error", result: message,
          duration_ms: Date.now() - started, workspace_name: bank, peer_name: peer,
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
