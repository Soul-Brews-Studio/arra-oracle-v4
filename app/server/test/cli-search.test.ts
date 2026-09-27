/**
 * `search` on the CLI (#30, overnight R7 #30 part; R8 "Legacy memory commands
 * stay"): the knowledge-tier search is reached with `--mode keyword|semantic`,
 * while a bare `search` -- and `--mode text|vector` -- stays the legacy
 * memories search, unchanged. Kept out of `app/cli.test.ts`, which is already
 * past the 500-line cap; same stub-server harness shape.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const cli = new URL("../../cli.ts", import.meta.url).pathname;
/** A synthetic credential. Never a real token. */
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const requests: { path: string; search: string; method: string; body: any; authorization: string | null }[] = [];
let response: unknown = {};
let responseStatus = 200;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    requests.push({
      path: url.pathname,
      search: url.search,
      method: req.method,
      body: req.method === "POST" ? await req.json().catch(() => null) : null,
      authorization: req.headers.get("authorization"),
    });
    return Response.json(response, { status: responseStatus });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  requests.length = 0;
  response = { mode: "text", match: "ngram", count: 0, rows: [] };
  responseStatus = 200;
});

async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: { ...process.env, ARRA_URL: `http://127.0.0.1:${server.port}`, ARRA_BANK: "test-bank", ARRA_TOKEN: TOKEN },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

describe("CLI search: legacy by default, knowledge tier by --mode (#30 R7, R8)", () => {
  test("bare search is still the legacy memories search (R8: legacy commands stay)", async () => {
    const r = await run("search", "--query", "legacyprobe");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(response);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/api/search");
    const query = new URLSearchParams(requests[0]!.search);
    expect(query.get("mode")).toBe("text");
    expect(query.get("q")).toBe("legacyprobe");
    expect(query.get("bank")).toBe("test-bank");
  });

  test("--mode vector keeps the legacy route too", async () => {
    const r = await run("search", "--query", "keys", "--mode", "vector");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/search");
    expect(new URLSearchParams(requests[0]!.search).get("mode")).toBe("vector");
  });

  test("--mode keyword posts searchKnowledgeKeyword to the registry route", async () => {
    // #30 coverage (search-chunk-v1.md section 21) passes through verbatim.
    response = { match: "ngram", scan_reason: null, coverage: "partial", coverage_reason: "candidate_ceiling", candidate_ceiling: 4096, hits: [] };
    const r = await run("search", "--bank", "test-bank", "--query", "ลืม", "--mode", "keyword", "--limit", "3");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(response);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/api/knowledge/test-bank/searchKnowledgeKeyword",
      method: "POST",
      authorization: `Bearer ${TOKEN}`,
      body: { workspace_name: "test-bank", query: "ลืม", limit: 3 },
    });
  });

  test("--mode semantic targets searchKnowledgeSemantic; --profile becomes embedding_profile", async () => {
    const r = await run("search", "--query", "keys", "--mode", "semantic", "--profile", "all-minilm", "--limit", "2");
    expect(r.code).toBe(0);
    expect(requests[0]?.path).toBe("/api/knowledge/test-bank/searchKnowledgeSemantic");
    expect(requests[0]?.body).toEqual({ workspace_name: "test-bank", query: "keys", limit: 2, embedding_profile: "all-minilm" });
  });

  for (const args of [
    ["search"],
    ["search", "--query", "x", "--mode", "fuzzy"],
    ["search", "--query", "x", "--profile", "all-minilm"],
    ["search", "--query", "x", "--mode", "text", "--profile", "all-minilm"],
    ["search", "--query", "x", "--mode", "keyword", "--profile", "all-minilm"],
    ["search", "--query", "x", "--mode", "keyword", "--limit", "0"],
  ]) {
    test(`rejects ${JSON.stringify(args)} before any network call`, async () => {
      expect((await run(...args)).code).toBe(1);
      expect(requests).toHaveLength(0);
    });
  }

  test("a governed refusal is printed unchanged and exits nonzero", async () => {
    response = { version: "arra-error/v1", code: "invalid_value", path: "/limit", message: "expected 1..50" };
    responseStatus = 400;
    const r = await run("search", "--query", "x", "--mode", "semantic");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual(response);
  });

  test("help keeps the legacy line and documents the knowledge modes", async () => {
    const r = await run("help");
    expect(r.out).toContain("search --query TEXT [--mode text|vector] [--limit N]");
    expect(r.out).toContain("search --bank NAME --query TEXT --mode keyword|semantic");
    expect(requests).toHaveLength(0);
  });
});
