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
