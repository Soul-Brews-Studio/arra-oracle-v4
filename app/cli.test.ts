import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const cli = new URL("./cli.ts", import.meta.url).pathname;
/** A synthetic credential. Never a real token. */
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const requests: { path: string; search: string; method: string; body: any; authorization: string | null }[] = [];
let response: unknown = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "[]" }] } };
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    requests.push({
      path: new URL(req.url).pathname,
      search: new URL(req.url).search,
      method: req.method,
      body: req.method === "POST" ? await req.json().catch(() => null) : null,
      authorization: req.headers.get("authorization"),
    });
    return Response.json(response);
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests.length = 0;
  extraEnv = {};
  response = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "[]" }] } };
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
    ["search", ["--query", "Thai ภาษาไทย"], "/api/search"],
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
