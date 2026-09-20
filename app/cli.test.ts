import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const cli = new URL("./cli.ts", import.meta.url).pathname;
const requests: { path: string; search: string; method: string; body: any }[] = [];
let response: unknown = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "[]" }] } };
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    requests.push({ path: new URL(req.url).pathname, search: new URL(req.url).search, method: req.method, body: req.method === "POST" ? await req.json().catch(() => null) : null });
    return Response.json(response);
  },
});
afterAll(() => server.stop(true));
beforeEach(() => { requests.length = 0; response = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "[]" }] } }; });
async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: { ...process.env, ARRA_URL: `http://127.0.0.1:${server.port}`, ARRA_BANK: "test-bank" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}
describe("CLI transport contract", () => {
  test("help never requests backend", async () => { const r = await run("help"); expect(r.code).toBe(0); expect(r.out).toContain("remember"); expect(requests).toHaveLength(0); });
  test("unknown command is nonzero", async () => { expect((await run("wat")).code).toBe(1); expect(requests).toHaveLength(0); });
  test("valid MCP request retains envelope and bank", async () => { const r = await run("recall", "--query", "schema", "--limit", "3"); expect(r.code).toBe(0); expect(JSON.parse(r.out)).toEqual(response); expect(requests[0]).toEqual({ path: "/mcp/test-bank", search: "", method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall", arguments: { query: "schema", mode: "text", limit: 3 } } } }); });
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
