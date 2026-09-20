#!/usr/bin/env bun
export {};
type Json = Record<string, unknown>;

const usage = `arra-v4 — Arra Oracle v4 CLI

Usage: bun app/cli.ts <command> [options]

MCP commands:
  remember --content TEXT [--name NAME] [--type TYPE] [--session NAME] [--peer NAME] [--subject NAME]
  recall --query TEXT [--mode text|vector] [--limit N]
  get-memory --id ID
  list-memories [--type TYPE] [--session NAME] [--peer NAME] [--subject NAME] [--active true|false] [--sync-state pending|synced|failed] [--limit N]
  bank-info | call-log [--limit N] [--status ok|error] | call-stats | status

HTTP commands:
  health | list [--limit N] | search --query TEXT [--mode text|vector] [--limit N]
  backfill [--batch N] | reindex
  NOTE: backfill/reindex are GLOBAL maintenance operations, not bank-scoped.

Global options: --url URL (ARRA_URL; default http://127.0.0.1:3939)
                --bank NAME (ARRA_BANK; default default), --pretty
Output is JSON. Invalid arguments, HTTP errors and MCP errors exit nonzero.
`;

const commandFlags: Record<string, string[]> = {
  remember: ["content", "name", "type", "session", "peer", "subject"],
  recall: ["query", "mode", "limit"], "get-memory": ["id"],
  "list-memories": ["type", "session", "peer", "subject", "active", "sync-state", "limit"],
  "bank-info": [], "call-log": ["limit", "status"], "call-stats": [], status: [],
  health: [], list: ["limit"], search: ["query", "mode", "limit"],
  backfill: ["batch"], reindex: [],
};
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

try {
  const args = Bun.argv.slice(2);
  const command = args.shift() ?? "help";
  if (["help", "--help", "-h"].includes(command)) {
    console.log(usage);
  } else {
    if (!Object.hasOwn(commandFlags, command)) throw new Error(`unknown command '${command}'\n\n${usage}`);
    const allowed = new Set([...commandFlags[command], "url", "bank", "pretty"]);
    const options: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(args[i]);
      if (!match || !allowed.has(match[1])) throw new Error(`unknown option '${args[i]}' for ${command}`);
      const [, name, inline] = match;
      if (Object.hasOwn(options, name)) throw new Error(`duplicate option --${name}`);
      if (name === "pretty") {
        if (inline !== undefined) throw new Error("--pretty takes no value");
        options[name] = "true";
      } else {
        const value = inline ?? args[++i];
        if (value === undefined || (inline === undefined && value.startsWith("--")) || !value.trim()) throw new Error(`--${name} requires a non-empty value`);
        options[name] = value;
      }
    }
    const required = (name: string) => {
      if (!options[name]) throw new Error(`--${name} is required`);
      return options[name];
    };
    const integer = (name: string, fallback: number) => {
      const value = options[name];
      if (value === undefined) return fallback;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 1000) throw new Error(`--${name} must be an integer from 1 to 1000`);
      return Number(value);
    };
    const choice = (name: string, values: string[], fallback?: string) => {
      const value = options[name] ?? fallback;
      if (value !== undefined && !values.includes(value)) throw new Error(`--${name} must be ${values.join("|")}`);
      return value;
    };
    const base = options.url ?? process.env.ARRA_URL ?? "http://127.0.0.1:3939";
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("--url must be an HTTP(S) base URL without credentials, query or fragment");
    const bank = options.bank ?? process.env.ARRA_BANK ?? "default";
    if (!bank.trim()) throw new Error("--bank must be non-empty");
    const output = (value: unknown) => console.log(JSON.stringify(value, (_k, v) => typeof v === "bigint" ? String(v) : v, options.pretty ? 2 : 0));
    const request = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${url.href.replace(/\/$/, "")}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
      const text = await response.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text; }
      if (!response.ok) throw new Error(`${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
      return body;
    };
    const mcp = async (tool: string, arguments_: Json = {}) => request(`/mcp/${encodeURIComponent(bank)}`, {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "arra-v4-cli" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: arguments_ } }),
    });
    let result: unknown;
    switch (command) {
      case "remember": result = await mcp("remember", { content: required("content"), name: options.name, type: options.type, session_name: options.session, peer_name: options.peer, subject_peer_name: options.subject }); break;
      case "recall": result = await mcp("recall", { query: required("query"), mode: choice("mode", ["text", "vector"], "text"), limit: integer("limit", 10) }); break;
      case "get-memory": result = await mcp("get_memory", { id: required("id") }); break;
      case "list-memories": result = await mcp("list_memories", { type: options.type, session_name: options.session, peer_name: options.peer, subject_peer_name: options.subject, is_active: options.active === undefined ? undefined : choice("active", ["true", "false"]) === "true", sync_state: choice("sync-state", ["pending", "synced", "failed"]), limit: integer("limit", 20) }); break;
      case "bank-info": result = await mcp("bank_info"); break;
      case "call-log": result = await mcp("call_log", { limit: integer("limit", 20), status: choice("status", ["ok", "error"]) }); break;
      case "call-stats": result = await mcp("call_stats"); break;
      case "status": result = await mcp("status"); break;
      case "health": result = await request("/health"); break;
      case "list": result = await request(`/api/memories?bank=${encodeURIComponent(bank)}&limit=${integer("limit", 50)}`); break;
      case "search": result = await request(`/api/search?bank=${encodeURIComponent(bank)}&q=${encodeURIComponent(required("query"))}&mode=${choice("mode", ["text", "vector"], "text")}&limit=${integer("limit", 10)}`); break;
      case "backfill": {
        const batch = integer("batch", 32);
        console.error("Global backfill: --bank does not scope this operation.");
        result = await request(`/api/backfill?batch=${batch}`, { method: "POST" }); break;
      }
      case "reindex": console.error("Global reindex: --bank does not scope this operation."); result = await request("/api/reindex", { method: "POST" }); break;
    }
    output(result);
    if (isObject(result) && (result.error != null || (isObject(result.result) && result.result.isError === true))) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
