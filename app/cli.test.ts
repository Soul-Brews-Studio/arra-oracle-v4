import { afterAll, beforeEach, describe, expect, test } from "bun:test";
// #31 R8 (CLI part): the CLI's advertised kb method list must equal this,
// imported the same way `app/cli.ts` itself does -- never hand-copied.
import { KNOWLEDGE_METHOD_NAMES } from "./server/src/knowledge/registry";

const cli = new URL("./cli.ts", import.meta.url).pathname;
/** A synthetic credential. Never a real token. */
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const requests: {
  path: string;
  search: string;
  method: string;
  body: any;
  /** The exact wire text, so a duplicate-key body's later-wins JSON.parse
   *  result never hides that the CLI forwarded it byte-for-byte. */
  rawBody: string | null;
  authorization: string | null;
}[] = [];
let response: unknown = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "[]" }] } };
/** Non-2xx lets kb/alias tests prove a governed envelope is printed unchanged. */
let responseStatus = 200;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const rawBody = req.method === "POST" ? await req.clone().text() : null;
    requests.push({
      path: new URL(req.url).pathname,
      search: new URL(req.url).search,
      method: req.method,
      body: rawBody === null ? null : await req.json().catch(() => null),
      rawBody,
      authorization: req.headers.get("authorization"),
    });
    return Response.json(response, { status: responseStatus });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests.length = 0;
  extraEnv = {};
  response = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "[]" }] } };
  responseStatus = 200;
});
let extraEnv: Record<string, string | undefined> = {};

async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: {
      ...process.env,
      ARRA_URL: `http://127.0.0.1:${server.port}`,
      ARRA_BANK: "test-bank",
      ARRA_TOKEN: TOKEN,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}
describe("CLI transport contract", () => {
  test("help never requests backend", async () => { const r = await run("help"); expect(r.code).toBe(0); expect(r.out).toContain("remember"); expect(requests).toHaveLength(0); });
  test("unknown command is nonzero", async () => { expect((await run("wat")).code).toBe(1); expect(requests).toHaveLength(0); });
  test("valid MCP request retains envelope and bank", async () => { const r = await run("recall", "--query", "schema", "--limit", "3"); expect(r.code).toBe(0); expect(JSON.parse(r.out)).toEqual(response); expect(requests[0]).toMatchObject({ path: "/mcp/test-bank", search: "", method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall", arguments: { query: "schema", mode: "text", limit: 3 } } } }); });
  test("recall and search print the server's match mode, and help says what it means (R14)", async () => {
    const answer = { mode: "text", match: "substring_scan", count: 0, rows: [] };
    response = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(answer) }] } };
    const recalled = await run("recall", "--query", "ไป");
    expect(recalled.code).toBe(0);
    expect(JSON.parse(JSON.parse(recalled.out).result.content[0].text)).toEqual(answer);
    response = { ...answer, match: "ngram" };
    // Legacy memories search needs its legacy mode named explicitly since #30
    // (R7): a bare `search` is the knowledge-tier search (see the block below).
    const searched = await run("search", "--query", "ลืม", "--mode", "text");
    expect(searched.code).toBe(0);
    expect(JSON.parse(searched.out)).toEqual({ ...answer, match: "ngram" });
    const help = await run("help");
    expect(help.out).toContain("match");
    expect(help.out).toContain("substring_scan");
  });
  test("subject survives remember request", async () => { expect((await run("remember", "--content", "fact", "--subject", "nat")).code).toBe(0); expect(requests[0]?.body.params.arguments.subject_peer_name).toBe("nat"); });
  test("status carries active versus proposed contract state unchanged", async () => {
    response = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ contract: { status: "proposed-not-active", active_tables: 15, target_tables: 19 } }) }] } };
    const r = await run("status");
    expect(r.code).toBe(0);
    expect(JSON.parse(JSON.parse(r.out).result.content[0].text).contract).toEqual({ status: "proposed-not-active", active_tables: 15, target_tables: 19 });
  });
  for (const args of [
    ["remember"], ["get-memory"], ["recall", "--query"], ["recall", "--query", "x", "--limit", "NaN"],
    ["recall", "--query", "x", "--limit", "0"], ["recall", "--query", "x", "--limit", "1.5"],
    ["recall", "--query", "x", "--mode", "other"], ["status", "--surprise"], ["status", "extra"],
    ["status", "--bank", ""], ["status", "--url", "file:///etc/passwd"],
    ["call-log", "--status", "pending"], ["list-memories", "--active", "yes"], ["list-memories", "--sync-state", "other"],
    ["recall", "--query", "x", "--limit", "1", "--limit", "2"],
  ]) test(`rejects invalid args ${JSON.stringify(args)} before network`, async () => { expect((await run(...args)).code).toBe(1); expect(requests).toHaveLength(0); });
  test("MCP isError is nonzero but keeps JSON output", async () => { response = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "denied" }], isError: true } }; const r = await run("status"); expect(r.code).toBe(1); expect(JSON.parse(r.out)).toEqual(response); });
  test("JSON-RPC error is nonzero", async () => { response = { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad input" } }; const r = await run("status"); expect(r.code).toBe(1); expect(JSON.parse(r.out)).toEqual(response); });
  for (const [command, flags, tool] of [
    ["get-memory", ["--id", "m_1"], "get_memory"],
    ["list-memories", ["--session", "s", "--peer", "neo", "--type", "note", "--sync-state", "pending"], "list_memories"],
    ["bank-info", [], "bank_info"], ["call-log", ["--status", "error"], "call_log"],
    ["call-stats", [], "call_stats"], ["status", [], "status"],
  ] as [string, string[], string][]) test(`routes MCP ${command}`, async () => {
    expect((await run(command, ...flags)).code).toBe(0);
    expect(requests[0]?.path).toBe("/mcp/test-bank");
    expect(requests[0]?.body.params.name).toBe(tool);
  });
  for (const [command, flags, path] of [
    ["health", [], "/health"], ["list", [], "/api/memories"],
    ["search", ["--query", "Thai ภาษาไทย", "--mode", "text"], "/api/search"],
    ["backfill", ["--batch", "2"], "/api/backfill"], ["reindex", [], "/api/reindex"],
  ] as [string, string[], string][]) test(`routes HTTP ${command}`, async () => {
    expect((await run(command, ...flags)).code).toBe(0); expect(requests[0]?.path).toBe(path);
    const request = requests[0];
    expect(request.method).toBe(["backfill", "reindex"].includes(command) ? "POST" : "GET");
    const query = new URLSearchParams(request.search);
    if (["list", "search"].includes(command)) expect(query.get("bank")).toBe("test-bank");
    if (command === "search") expect(query.get("q")).toBe("Thai ภาษาไทย");
    if (command === "backfill") expect(query.get("batch")).toBe("2");
  });
  test("explicit bank is escaped and pretty output is JSON", async () => {
    const r = await run("status", "--bank", "neo/test", "--pretty");
    expect(r.code).toBe(0); expect(requests[0]?.path).toBe("/mcp/neo%2Ftest");
    expect(r.out).toContain("\n  "); expect(JSON.parse(r.out)).toEqual(response);
  });
  test("inline content supports leading double hyphen", async () => {
    expect((await run("remember", "--content=--literal")).code).toBe(0);
    expect(requests[0]?.body.params.arguments.content).toBe("--literal");
  });
  test("list forwards subject and false active filter", async () => {
    expect((await run("list-memories", "--subject", "nat", "--active", "false")).code).toBe(0);
    expect(requests[0]?.body.params.arguments).toMatchObject({ subject_peer_name: "nat", is_active: false });
  });
  test("offline requests fail", async () => { expect((await run("status", "--url", "http://127.0.0.1:1")).code).toBe(1); });
});

describe("CLI credential handling (#25 §5)", () => {
  test("a protected command sends exactly one Bearer header", async () => {
    expect((await run("recall", "--query", "x")).code).toBe(0);
    expect(requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("the public health command sends NO credential", async () => {
    expect((await run("health")).code).toBe(0);
    expect(requests[0]?.path).toBe("/health");
    expect(requests[0]?.authorization).toBeNull();
  });

  test("health works with no token configured at all", async () => {
    extraEnv = { ARRA_TOKEN: undefined };
    expect((await run("health")).code).toBe(0);
    expect(requests[0]?.authorization).toBeNull();
  });

  test("a protected command refuses to run without a token, before any network", async () => {
    extraEnv = { ARRA_TOKEN: undefined };
    const r = await run("recall", "--query", "x");
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("a malformed token is refused before any network", async () => {
    for (const bad of [TOKEN.toUpperCase(), TOKEN.slice(0, 63), `${TOKEN}0`, "not-hex", ""]) {
      extraEnv = { ARRA_TOKEN: bad };
      const r = await run("recall", "--query", "x");
      expect(r.code).toBe(1);
      expect(requests).toHaveLength(0);
    }
  });

  test("there is no token flag: passing one is rejected as an unknown option", async () => {
    for (const flag of [["--token", TOKEN], ["--authorization", TOKEN], ["--bearer", TOKEN]]) {
      const r = await run("recall", "--query", "x", ...flag);
      expect(r.code).toBe(1);
      expect(requests).toHaveLength(0);
    }
  });

  test("the token never appears in stdout or stderr, on success or failure", async () => {
    const ok = await run("recall", "--query", "x");
    expect(ok.out).not.toContain(TOKEN);
    expect(ok.err).not.toContain(TOKEN);
    response = { error: "nope" };
    const bad = await run("get-memory", "--id", "missing");
    expect(bad.out).not.toContain(TOKEN);
    expect(bad.err).not.toContain(TOKEN);
    extraEnv = { ARRA_TOKEN: "short" };
    const refused = await run("recall", "--query", "x");
    expect(refused.err).not.toContain("short");
  });

  test("a credential is never sent over plain HTTP to a non-loopback host", async () => {
    // `localhost` is excluded on purpose: it resolves through DNS.
    for (const host of ["localhost", "example.com", "169.254.169.254"]) {
      const r = await run("recall", "--query", "x", "--url", `http://${host}:9999`);
      expect(r.code).toBe(1);
      expect(requests).toHaveLength(0);
    }
  });

  test("global maintenance commands carry no bank parameter", async () => {
    expect((await run("backfill")).code).toBe(0);
    expect(requests[0]?.search).not.toContain("bank");
    expect((await run("reindex")).code).toBe(0);
    expect(requests[0]?.search).not.toContain("bank");
  });
});

describe("CLI redirect refusal and loopback literals (reviewer round)", () => {
  test("a redirect is refused in EXECUTION, and the target receives nothing", async () => {
    // Setting redirect:'error' is not proof it runs. This stands up a real
    // second listener and asserts it is never contacted at all.
    const target: { hits: { authorization: string | null }[] } = { hits: [] };
    const targetServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        target.hits.push({ authorization: req.headers.get("authorization") });
        return Response.json({ captured: true });
      },
    });
    const redirector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${targetServer.port}/mcp/test-bank` },
        });
      },
    });
    try {
      const child = Bun.spawn(
        [process.execPath, cli, "recall", "--query", "x", "--url", `http://127.0.0.1:${redirector.port}`],
        { env: { ...process.env, ARRA_TOKEN: TOKEN, ARRA_BANK: "test-bank" }, stdout: "pipe", stderr: "pipe" },
      );
      const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(1);
      // The redirect target was never contacted, so no credential leaked.
      expect(target.hits).toHaveLength(0);
      expect(err).not.toContain(TOKEN);
    } finally {
      redirector.stop(true);
      targetServer.stop(true);
    }
  });

  test("loopback ALIASES are rejected before the network, despite normalising to 127.0.0.1", async () => {
    // These do resolve to loopback, so this is not an exfiltration claim; the
    // contract permits only the two literal spellings, and normalisation must
    // not widen that.
    //
    // Pointed at the LIVE test server on purpose: an earlier version used a
    // dead port, so the CLI exited nonzero from connection refusal and the
    // test passed whether or not the rule existed. Aimed here, a permissive
    // rule would genuinely connect and record a request.
    for (const host of ["2130706433", "127.1", "0x7f000001", "127.000.000.001"]) {
      const r = await run("recall", "--query", "x", "--url", `http://${host}:${server.port}`);
      expect(r.code).toBe(1);
      expect(requests).toHaveLength(0);
    }
  });

  test("the two literal loopback spellings are still accepted", async () => {
    // 127.0.0.1 is exercised throughout; assert the rule did not over-tighten.
    expect((await run("recall", "--query", "x")).code).toBe(0);
    expect(requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

// ── #31 R8 (CLI part): generic `kb <method>` over the server's own registry ─

/** Pull the method column out of `kb --help`'s "Methods (N total):" block,
 *  so the assertion below reads the SAME rendered text a human sees rather
 *  than reaching past the CLI into its internals. */
function methodNamesFromKbHelp(helpText: string): string[] {
  const lines = helpText.split("\n");
  const start = lines.findIndex((line) => /^Methods \(\d+ total\):$/.test(line));
  if (start === -1) throw new Error("kb --help did not print a Methods header");
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    const name = line.trim().split(/\s+/)[0];
    if (name) names.push(name);
  }
  return names;
}

describe("CLI kb <method> (#31 R8)", () => {
  test("kb dispatches to /api/knowledge instead of printing usage", async () => {
    // The exact failing-first symptom: before this slice, `kb` was an unknown
    // top-level command and printed usage with exit 1, touching no network.
    const r = await run("kb", "listNodes", "--bank", "test-bank", "--json", '{"workspace_name":"test-bank","after_id":null,"limit":1,"include_total":false,"type_term":null}');
    expect(r.out).not.toContain("Usage: bun app/cli.ts <command>");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/knowledge/test-bank/listNodes");
    expect(requests[0]?.method).toBe("POST");
  });

  test("the CLI's advertised kb method list equals the registry's, exactly", async () => {
    const r = await run("kb", "--help");
    expect(r.code).toBe(0);
    const advertised = methodNamesFromKbHelp(r.out);
    expect(new Set(advertised)).toEqual(new Set(KNOWLEDGE_METHOD_NAMES));
    expect(advertised).toHaveLength(KNOWLEDGE_METHOD_NAMES.length);
  });

  test("kb --help sends no request", async () => {
    const r = await run("kb", "--help");
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(0);
  });

  test("bare kb (no method) prints the same help as kb --help, sends no request", async () => {
    const r = await run("kb");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Methods (");
    expect(requests).toHaveLength(0);
  });

  test("kb <method> --help prints that method's action and scope, sends no request", async () => {
    const r = await run("kb", "publishRevision", "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("publishRevision");
    expect(r.out).toContain("content:write");
    expect(requests).toHaveLength(0);
  });

  test("kb with an unknown method exits nonzero before any network call", async () => {
    const r = await run("kb", "definitelyNotAMethod", "--bank", "test-bank", "--json", "{}");
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("kb with an unknown method plus --help also exits nonzero before any network call", async () => {
    const r = await run("kb", "definitelyNotAMethod", "--help");
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("kb with no body source (--json/--file/--stdin) exits nonzero before any network call", async () => {
    const r = await run("kb", "listNodes", "--bank", "test-bank");
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("kb refuses two body sources at once, before any network call", async () => {
    const r = await run("kb", "listNodes", "--bank", "test-bank", "--json", "{}", "--file", "/tmp/does-not-matter");
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("kb forwards the --json body BYTE-EXACT, duplicate keys included", async () => {
    // JSON.parse on the wire text collapses duplicate keys to last-wins, so
    // the assertion reads the raw text the stub captured, never `req.json()`.
    const dup = '{"workspace_name":"test-bank","workspace_name":"test-bank","after_id":null,"limit":1,"include_total":false,"type_term":null}';
    const r = await run("kb", "listNodes", "--bank", "test-bank", "--json", dup);
    expect(r.code).toBe(0);
    expect(requests[0]?.rawBody).toBe(dup);
  });

  test("kb reads the body from --file untouched", async () => {
    const path = `${await import("node:os").then((m) => m.tmpdir())}/arra-cli-kb-${Date.now()}.json`;
    const payload = '{"workspace_name":"test-bank","after_id":null,"limit":2,"include_total":false,"type_term":null}';
    await Bun.write(path, payload);
    try {
      const r = await run("kb", "listNodes", "--bank", "test-bank", "--file", path);
      expect(r.code).toBe(0);
      expect(requests[0]?.rawBody).toBe(payload);
    } finally {
      await Bun.file(path).delete().catch(() => undefined);
    }
  });

  test("kb reads the body from --stdin untouched", async () => {
    const payload = '{"workspace_name":"test-bank","after_id":null,"limit":3,"include_total":false,"type_term":null}';
    const child = Bun.spawn([process.execPath, cli, "kb", "listNodes", "--bank", "test-bank", "--stdin"], {
      env: { ...process.env, ARRA_URL: `http://127.0.0.1:${server.port}`, ARRA_BANK: "test-bank", ARRA_TOKEN: TOKEN },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    child.stdin.write(payload);
    child.stdin.end();
    const [code] = await Promise.all([child.exited]);
    expect(code).toBe(0);
    expect(requests[0]?.rawBody).toBe(payload);
  });

  test("a governed error envelope is printed unchanged and exits nonzero", async () => {
    responseStatus = 409;
    response = { version: "arra-taxonomy-error/v1", code: "conflict", path: "/name", message: "already exists" };
    const r = await run("kb", "createVocabulary", "--bank", "test-bank", "--json", '{"workspace_name":"test-bank","name":"x"}');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual(response);
  });

  test("kb sends exactly one Bearer header, the same #25 §5 rule as every other command", async () => {
    const r = await run("kb", "listNodes", "--bank", "test-bank", "--json", '{"workspace_name":"test-bank","after_id":null,"limit":1,"include_total":false,"type_term":null}');
    expect(r.code).toBe(0);
    expect(requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("kb refuses to run without a token, before any network call", async () => {
    extraEnv = { ARRA_TOKEN: undefined };
    const r = await run("kb", "listNodes", "--bank", "test-bank", "--json", "{}");
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("kb never sends a credential over plain HTTP to a non-loopback host", async () => {
    const r = await run("kb", "listNodes", "--bank", "test-bank", "--json", "{}", "--url", "http://example.com:9999");
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("an unknown flag for kb is rejected before any network call", async () => {
    const r = await run("kb", "listNodes", "--bank", "test-bank", "--json", "{}", "--surprise");
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(0);
  });
});

describe("CLI kb friendly aliases (#31 R8)", () => {
  test("peer add registers a peer, minting a peer_id when none is given", async () => {
    const r = await run("peer", "add", "--bank", "test-bank", "--name", "nat");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/knowledge/test-bank/registerPeer");
    const body = requests[0]?.body;
    expect(body).toMatchObject({ workspace_name: "test-bank", name: "nat" });
    expect(body.peer_id).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  test("peer add without --name exits nonzero before any network call", async () => {
    const r = await run("peer", "add", "--bank", "test-bank");
    expect(r.code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("session add registers a session", async () => {
    const r = await run("session", "add", "--bank", "test-bank", "--name", "standup");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/knowledge/test-bank/registerSession");
    expect(requests[0]?.body).toMatchObject({ workspace_name: "test-bank", name: "standup" });
  });

  test("message append wraps one message as the items array appendMessages expects", async () => {
    const r = await run("message", "append", "--bank", "test-bank", "--session", "standup", "--peer", "nat", "--content", "hello");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/knowledge/test-bank/appendMessages");
    const body = requests[0]?.body;
    expect(body.workspace_name).toBe("test-bank");
    expect(body.session_name).toBe("standup");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ message: { peer_name: "nat", content: "hello", role: null, in_reply_to: null }, source: null });
    expect(body.items[0].public_id).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  test("nodes list forwards paging flags with explicit nulls for the rest", async () => {
    const r = await run("nodes", "list", "--bank", "test-bank", "--limit", "5", "--include-total");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/knowledge/test-bank/listNodes");
    expect(requests[0]?.body).toEqual({
      workspace_name: "test-bank", after_id: null, limit: 5, include_total: true, type_term: null,
    });
  });

  test("context get maps onto getContext", async () => {
    const r = await run("context", "get", "--bank", "test-bank", "--peer", "nat", "--session", "standup");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/knowledge/test-bank/getContext");
    expect(requests[0]?.body).toMatchObject({ workspace_name: "test-bank", peer_name: "nat", session_name: "standup" });
  });

  test("chat ask maps onto answerChat", async () => {
    const r = await run("chat", "ask", "--bank", "test-bank", "--peer", "nat", "--session", "standup", "--question", "what happened?");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/knowledge/test-bank/answerChat");
    expect(requests[0]?.body).toMatchObject({ workspace_name: "test-bank", peer_name: "nat", session_name: "standup", question: "what happened?" });
  });

  test("aliases carry credentials under the same #25 §5 rule", async () => {
    const r = await run("peer", "add", "--bank", "test-bank", "--name", "nat");
    expect(r.code).toBe(0);
    expect(requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("CLI help marks the legacy 13 without removing them (#31 R8)", () => {
  test("help lists every legacy command name plus a legacy label", async () => {
    const r = await run("help");
    expect(r.code).toBe(0);
    for (const legacyCommand of [
      "remember", "recall", "get-memory", "list-memories", "bank-info", "call-log",
      "call-stats", "status", "health", "list", "search", "backfill", "reindex",
    ]) expect(r.out).toContain(legacyCommand);
    expect(r.out.toLowerCase()).toContain("legacy");
  });

  test("help also advertises kb and the friendly aliases", async () => {
    const r = await run("help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("kb ");
    expect(r.out).toContain("peer add");
  });
});

// ── #30 (overnight R7 #30 part + R14): `search` over the knowledge tier ──────

describe("CLI search over kb (#30 R7)", () => {
  test("bare search is the knowledge keyword search, posted to the registry route", async () => {
    response = { match: "ngram", scan_reason: null, hits: [] };
    const r = await run("search", "--bank", "test-bank", "--query", "ลืม");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(response);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/api/knowledge/test-bank/searchKnowledgeKeyword",
      method: "POST",
      authorization: `Bearer ${TOKEN}`,
      body: { workspace_name: "test-bank", query: "ลืม" },
    });
  });

  test("--mode keyword with --limit forwards an integer limit", async () => {
    const r = await run("search", "--query", "ลืม", "--mode", "keyword", "--limit", "3");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/knowledge/test-bank/searchKnowledgeKeyword");
    expect(requests[0]?.body).toEqual({ workspace_name: "test-bank", query: "ลืม", limit: 3 });
  });

  test("--mode semantic targets searchKnowledgeSemantic; --profile becomes embedding_profile", async () => {
    const r = await run("search", "--query", "keys", "--mode", "semantic", "--profile", "all-minilm", "--limit", "2");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/knowledge/test-bank/searchKnowledgeSemantic");
    expect(requests[0]?.body).toEqual({ workspace_name: "test-bank", query: "keys", limit: 2, embedding_profile: "all-minilm" });
  });

  test("--mode text|vector keeps the legacy memories search route", async () => {
    const r = await run("search", "--query", "keys", "--mode", "vector");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/search");
    expect(new URLSearchParams(requests[0]!.search).get("mode")).toBe("vector");
  });

  for (const args of [
    ["search"], ["search", "--query", "x", "--mode", "fuzzy"],
    ["search", "--query", "x", "--profile", "all-minilm"],
    ["search", "--query", "x", "--mode", "text", "--profile", "all-minilm"],
    ["search", "--query", "x", "--limit", "0"],
  ]) test(`rejects ${JSON.stringify(args)} before any network call`, async () => {
    expect((await run(...args)).code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  test("a governed refusal is printed unchanged and exits nonzero", async () => {
    response = { version: "arra-error/v1", code: "invalid_value", path: "/limit", message: "expected 1..50" };
    responseStatus = 400;
    const r = await run("search", "--query", "x", "--mode", "semantic");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual(response);
  });

  test("help documents the knowledge search and the legacy modes", async () => {
    const r = await run("help");
    expect(r.out).toContain("search --bank NAME --query TEXT [--mode keyword|semantic]");
    expect(r.out).toContain("searchKnowledgeKeyword");
  });
});
