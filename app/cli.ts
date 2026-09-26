#!/usr/bin/env bun
export {};
import { KNOWLEDGE_METHODS, KNOWLEDGE_METHOD_NAMES } from "./server/src/knowledge/registry";
import { KB_ALIASES } from "./cli/kb.aliases";
import { kbHelpText } from "./cli/kb.help";
import { parseFlags, type CliOptions } from "./cli/parseFlags";
import { positiveInt } from "./cli/positiveInt";
import { readKbRequestBody } from "./cli/kb.readRequestBody";
import { searchKnowledgeRequest } from "./cli/searchKnowledgeRequest";

type Json = Record<string, unknown>;

const usage = `arra-v4 — Arra Oracle v4 CLI

Usage: bun app/cli.ts <command> [options]

Knowledge commands (#31 R8 — generated from app/server/src/knowledge/registry.ts,
${KNOWLEDGE_METHOD_NAMES.length} methods; a method added there needs no CLI edit to appear here):
  kb --help                                    list every method
  kb <method> --help                           show that method's action and scope
  kb <method> --bank NAME [--json JSON | --file PATH | --stdin] [--pretty]

Friendly aliases (thin sugar over kb; --bank is required on all of these):
  peer add --bank NAME --name NAME [--peer-id ID]
  session add --bank NAME --name NAME [--session-id ID]
  message append --bank NAME --session NAME --peer NAME --content TEXT [--role R] [--in-reply-to ID]
  nodes list --bank NAME [--after ID] [--limit N] [--include-total] [--type TERM]
  context get --bank NAME --peer NAME --session NAME [--max-items N]
  chat ask --bank NAME --peer NAME --session NAME --question TEXT [--max-items N]
  search --bank NAME --query TEXT --mode keyword|semantic [--limit N] [--profile NAME]
      knowledge-tier recall (#30): keyword = searchKnowledgeKeyword, semantic =
      searchKnowledgeSemantic (--profile: stored embedding profile, semantic only;
      default: the server's query embedder's own). Answers are nodes at their
      current head, retired/superseded excluded; keyword says match "ngram" or
      "substring_scan"; the two are never fused. Without --mode keyword|semantic,
      search is the legacy memories search below, unchanged.

Legacy commands (13; kept for compatibility, not removed — prefer kb/aliases for new work):
  remember --content TEXT [--name NAME] [--type TYPE] [--session NAME] [--peer NAME] [--subject NAME]
  recall --query TEXT [--mode text|vector] [--limit N]
  get-memory --id ID
  list-memories [--type TYPE] [--session NAME] [--peer NAME] [--subject NAME] [--active true|false] [--sync-state pending|synced|failed] [--limit N]
  bank-info | call-log [--limit N] [--status ok|error] | call-stats | status
  health | list [--limit N] | search --query TEXT [--mode text|vector] [--limit N]
  backfill [--batch N] | reindex
  NOTE: backfill/reindex are GLOBAL maintenance operations, not bank-scoped.

recall and search (text|vector) answer {mode, match, count, rows}. Text mode is a substring
match: match is "ngram" (character-trigram index, each hit re-checked to contain
the query, case-insensitive) or "substring_scan" (a query under 3 characters,
scanned instead). Vector mode has no match field.

Global options: --url URL (ARRA_URL; default http://127.0.0.1:3939)
                --bank NAME (ARRA_BANK; default default), --pretty
Credentials: ARRA_TOKEN only - 64 lowercase hex characters. There is no token
flag and no config lookup, and the token is never printed. The health command
is public and sends no credential. Over plain HTTP a token is sent only to
127.0.0.1 or [::1]; any other host requires HTTPS.
Output is JSON. Invalid arguments, HTTP errors and MCP/knowledge errors exit nonzero.
`;

const commandFlags: Record<string, string[]> = {
  remember: ["content", "name", "type", "session", "peer", "subject"],
  recall: ["query", "mode", "limit"], "get-memory": ["id"],
  "list-memories": ["type", "session", "peer", "subject", "active", "sync-state", "limit"],
  "bank-info": [], "call-log": ["limit", "status"], "call-stats": [], status: [],
  health: [], list: ["limit"], search: ["query", "mode", "limit", "profile"],
  backfill: ["batch"], reindex: [],
};
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

try {
  const args = Bun.argv.slice(2);
  let command = args.shift() ?? "help";

  // Fold a two-word friendly alias ("peer add", "nodes list", ...) into one
  // dispatch key, the same way `kb <method>` treats `<method>` as data
  // rather than a second top-level command.
  if (args.length > 0 && Object.hasOwn(KB_ALIASES, `${command} ${args[0]}`)) {
    command = `${command} ${args.shift()}`;
  }

  if (["help", "--help", "-h"].includes(command)) {
    console.log(usage);
  } else if (command === "kb" && (args[0] === undefined || args[0] === "--help" || args[0] === "-h")) {
    // `kb` / `kb --help`: the method list itself, no credential needed.
    console.log(kbHelpText());
  } else if (command === "kb" && args[0]!.startsWith("--")) {
    throw new Error(`kb requires a method name (got '${args[0]}')\n\n${kbHelpText()}`);
  } else if (command === "kb" && (args.includes("--help") || args.includes("-h"))) {
    // `kb <method> --help`: that one method's action/scope, no credential needed.
    console.log(kbHelpText(args[0]));
  } else {
    let method: string | null = null;
    let alias: (typeof KB_ALIASES)[string] | null = null;
    let allowed: Set<string>;
    let booleanFlags: Set<string>;

    if (command === "kb") {
      method = args.shift()!;
      if (!Object.hasOwn(KNOWLEDGE_METHODS, method)) throw new Error(`unknown kb method '${method}'\n\n${kbHelpText()}`);
      allowed = new Set(["url", "bank", "pretty", "json", "file", "stdin"]);
      booleanFlags = new Set(["pretty", "stdin"]);
    } else if (Object.hasOwn(KB_ALIASES, command)) {
      alias = KB_ALIASES[command]!;
      allowed = new Set([...alias.flags, "url", "bank", "pretty"]);
      booleanFlags = new Set(["pretty", ...(alias.booleanFlags ?? [])]);
    } else {
      if (!Object.hasOwn(commandFlags, command)) throw new Error(`unknown command '${command}'\n\n${usage}`);
      allowed = new Set([...commandFlags[command]!, "url", "bank", "pretty"]);
      booleanFlags = new Set(["pretty"]);
    }

    const options: CliOptions = parseFlags(args, allowed, booleanFlags, command);

    const required = (name: string) => {
      if (!options[name]) throw new Error(`--${name} is required`);
      return options[name];
    };
    const integer = (name: string, fallback: number) => positiveInt(options[name], name, fallback);
    const choice = (name: string, values: string[], fallback?: string) => {
      const value = options[name] ?? fallback;
      if (value !== undefined && !values.includes(value)) throw new Error(`--${name} must be ${values.join("|")}`);
      return value;
    };
    // The ONLY credential source. No flag, no URL credentials, no config file.
    const token = process.env.ARRA_TOKEN;
    // `health` is the one public command: it needs no token and sends none.
    const isPublic = command === "health";
    if (!isPublic) {
      if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
        throw new Error("ARRA_TOKEN must be exactly 64 lowercase hex characters");
      }
    }

    const base = options.url ?? process.env.ARRA_URL ?? "http://127.0.0.1:3939";
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("--url must be an HTTP(S) base URL without credentials, query or fragment");
    const bank = options.bank ?? process.env.ARRA_BANK ?? "default";
    if (!bank.trim()) throw new Error("--bank must be non-empty");
    const output = (value: unknown) => console.log(JSON.stringify(value, (_k, v) => typeof v === "bigint" ? String(v) : v, options.pretty ? 2 : 0));
    // A bearer over plain HTTP goes only to the TEXTUAL loopback literals.
    //
    // Checked against the ORIGINAL authority, not the parsed hostname: URL
    // normalisation turns 2130706433, 127.1 and 0x7f000001 into 127.0.0.1, and
    // while those do resolve to loopback, the contract deliberately permits
    // only the two literal spellings. Validating post-normalisation would
    // silently widen the rule.
    const LOOPBACK_LITERALS = new Set(["127.0.0.1", "[::1]"]);
    const originalAuthority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(base)?.[1] ?? "";
    const originalHost = originalAuthority.replace(/:\d+$/, "");
    if (!isPublic && url.protocol === "http:" && !LOOPBACK_LITERALS.has(originalHost)) {
      throw new Error("refusing to send a credential over plain HTTP to a non-loopback host");
    }

    // The single fetch primitive: exactly one Authorization header (never on
    // the public command), a redirect refusal (a redirect could carry the
    // credential to another origin), and a bounded timeout. NEVER throws on a
    // non-2xx response -- callers decide whether to surface the body as a
    // thrown message (`request`) or print it unchanged and flag a nonzero
    // exit (the `kb`/alias dispatch below), but both share this one place
    // that touches the Authorization header, so the credential rule cannot
    // drift between them.
    const rawRequest = async (path: string, init?: RequestInit, timeoutMs = 30_000) => {
      const headers = new Headers((init?.headers as HeadersInit | undefined) ?? {});
      if (!isPublic) headers.set("authorization", `Bearer ${token}`);
      const response = await fetch(`${url.href.replace(/\/$/, "")}${path}`, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: response.status, ok: response.ok, body };
    };
    const request = async (path: string, init?: RequestInit) => {
      const { ok, status, body } = await rawRequest(path, init);
      if (!ok) throw new Error(`${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
      return body;
    };
    const mcp = async (tool: string, arguments_: Json = {}) => request(`/mcp/${encodeURIComponent(bank)}`, {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "arra-v4-cli" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: arguments_ } }),
    });
    // answerChat waits on a model the server bounds at 60 s (#32 / R9); the
    // CLI outwaits that bound so a slow answer arrives as the server's own
    // result (an answer or model_unavailable), never a local abort.
    const postKnowledge = (targetMethod: string, bytes: Uint8Array) => rawRequest(
      `/api/knowledge/${encodeURIComponent(bank)}/${encodeURIComponent(targetMethod)}`,
      { method: "POST", headers: { "content-type": "application/json", "user-agent": "arra-v4-cli" }, body: bytes as BodyInit },
      targetMethod === "answerChat" ? 75_000 : 30_000,
    );

    let result: unknown;
    let nonzeroExit = false;

    if (method !== null) {
      // `kb <method>`: forward the caller's bytes UNCHANGED to the same
      // /api/knowledge/:bank/:method route every other transport dispatches
      // through (`knowledge/transport.ts`). A non-2xx response is printed,
      // not thrown, so the governed envelope reaches stdout unchanged.
      const bytes = await readKbRequestBody(options);
      const { ok, body } = await postKnowledge(method, bytes);
      result = body;
      if (!ok) nonzeroExit = true;
    } else if (alias !== null) {
      const bytes = new TextEncoder().encode(JSON.stringify(alias.build(options, bank)));
      const { ok, body } = await postKnowledge(alias.method, bytes);
      result = body;
      if (!ok) nonzeroExit = true;
    } else {
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
        case "search": {
          // #30: --mode keyword|semantic is the knowledge tier over kb. The
          // default stays `text`, the legacy memories route, unchanged (R8:
          // legacy commands stay -- a bare `search` must answer what it did).
          const mode = choice("mode", ["keyword", "semantic", "text", "vector"], "text")!;
          if (mode === "keyword" || mode === "semantic") {
            const target = searchKnowledgeRequest(options, bank, mode);
            const { ok, body } = await postKnowledge(target.method, new TextEncoder().encode(JSON.stringify(target.body)));
            result = body;
            if (!ok) nonzeroExit = true;
            break;
          }
          if (options.profile !== undefined) throw new Error("--profile applies to --mode semantic only");
          result = await request(`/api/search?bank=${encodeURIComponent(bank)}&q=${encodeURIComponent(required("query"))}&mode=${mode}&limit=${integer("limit", 10)}`);
          break;
        }
        case "backfill": {
          const batch = integer("batch", 32);
          console.error("Global backfill: --bank does not scope this operation.");
          result = await request(`/api/backfill?batch=${batch}`, { method: "POST" }); break;
        }
        case "reindex": console.error("Global reindex: --bank does not scope this operation."); result = await request("/api/reindex", { method: "POST" }); break;
      }
    }
    output(result);
    if (nonzeroExit || (isObject(result) && (result.error != null || (isObject(result.result) && result.result.isError === true)))) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
