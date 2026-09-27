// #31 cross-transport AUDIT PARITY, live (acceptance-criteria slice,
// 2026-09-26). The same method called over HTTP, MCP and the real CLI, on a
// REAL listening server over a fresh writer-gated dataset
// (`fixtures/transport-v1/live-server/child.ts`), then the audit trail read
// back over the wire.
//
// What the contracts say is audited, and therefore what is asserted -- no
// parity is invented where the contract does not promise it:
//   - authorization-integration-v1.md §4: an audit row is "an internal
//     consequence of an admitted TOOL operation". Only MCP `tools/call`
//     appends (`auth/service.ts` `appendAudit`, the one sink), ok AND error.
//     `POST /api/knowledge/:bank/:method` is not a tool call and writes NO
//     row, so an HTTP call must leave the trail unchanged.
//   - The CLI has two legs (`app/cli.ts`): `kb <method>` forwards to the HTTP
//     route (so, like HTTP, no row), and the legacy commands call MCP tools
//     (so a row, exactly like a direct MCP call, differing only in the
//     transport user agent).
//   - R5 (docs/overnight/DECISIONS.md): rows live in the operations root and
//     are read by `listMcpCalls`/`listConnections`. R19: `connections.method`
//     is `bearer`, `principal` the credential id.
//   - Redaction (§4 + `mcp/calls.ts`): no bearer token anywhere in a row; the
//     `h_metadata` block is exactly {input, result, auth}; a secret-shaped
//     argument is redacted the same way whichever client sent it.

import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, PYTHON, runGated } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = join(import.meta.dir, "fixtures", "transport-v1", "live-server", "child.ts");
const TEST_TIMEOUT_MS = testTimeout(180_000);
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
if (!existsSync(CHILD)) MISSING.push("fixtures/transport-v1/live-server/child.ts");
test("preflight: every dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});
const runIt = MISSING.length > 0 ? test.skip : test;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const listNodes = { workspace_name: ALPHA, after_id: null, limit: 5, include_total: false, type_term: null };
// A refused request: the session does not exist (invalid_reference).
const badContext = { workspace_name: ALPHA, peer_name: "nobody", session_name: "no-such-session", max_items: 5 };
// A secret-shaped argument the audit writer must redact identically for
// every client (`ASSIGNED_SECRET` in `mcp/calls.ts`).
const SECRET_QUERY = "token=hunter2-live-parity-secret";
const recallArgs = { query: SECRET_QUERY, mode: "text", limit: 10 };
const listCalls = { workspace_name: ALPHA, after_id: null, limit: 200, tool: null, status: null, include_total: true };
const listConns = { workspace_name: ALPHA, after_id: null, limit: 200, include_total: true };

type Row = {
  tool: string;
  status: string;
  h_metadata: string | null;
  internal_metadata: string | null;
  [key: string]: unknown;
};

runIt(
  "HTTP, MCP and CLI land in the audit trail exactly where the contract says, with matching status and redaction",
  async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    cleanups.push(fixture.cleanup);
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-audit-parity-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const kbArgv = (method: string, body: unknown) => ["kb", method, "--json", JSON.stringify(body)];
    const steps = [
      // Baseline: the trail starts empty (read over HTTP, which is itself unaudited).
      { label: "calls_before", transport: "http", token: "audit", bank: "alpha", method: "listMcpCalls", body: listCalls },
      // ok: the same knowledge method on all three transports.
      { label: "http_ok", transport: "http", token: "write", bank: "alpha", method: "listNodes", body: listNodes },
      { label: "mcp_ok", transport: "mcp", token: "write", bank: "alpha", method: "kb_listNodes", body: { payload: listNodes } },
      { label: "cli_kb_ok", transport: "cli", token: "write", bank: "alpha", method: "", argv: kbArgv("listNodes", listNodes) },
      // error: the same refused request on all three transports.
      { label: "http_err", transport: "http", token: "write", bank: "alpha", method: "getContext", body: badContext },
      { label: "mcp_err", transport: "mcp", token: "write", bank: "alpha", method: "kb_getContext", body: { payload: badContext } },
      { label: "cli_kb_err", transport: "cli", token: "write", bank: "alpha", method: "", argv: kbArgv("getContext", badContext) },
      // The CLI's MCP leg vs a direct MCP call, same tool and arguments.
      { label: "mcp_recall", transport: "mcp", token: "write", bank: "alpha", method: "recall", body: recallArgs },
      { label: "cli_recall", transport: "cli", token: "write", bank: "alpha", method: "", argv: ["recall", "--query", SECRET_QUERY, "--mode", "text", "--limit", "10"] },
      { label: "mcp_stats", transport: "mcp", token: "audit", bank: "alpha", method: "call_stats", body: {} },
      { label: "cli_stats", transport: "cli", token: "audit", bank: "alpha", method: "", argv: ["call-stats"] },
      // The connection fold is fire-and-forget (composition.ts): let it land.
      { label: "settle", transport: "settle", token: "audit", bank: "alpha", method: "", ms: 750 },
      { label: "calls_after", transport: "http", token: "audit", bank: "alpha", method: "listMcpCalls", body: listCalls },
      { label: "conns_after", transport: "http", token: "audit", bank: "alpha", method: "listConnections", body: listConns },
    ];
    const result = await runGated(fixture.datasetRoot, CHILD, [
      fixture.datasetRoot,
      workDir,
      JSON.stringify({ banks: { alpha: ALPHA, beta: BETA }, steps }),
    ]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(-2000)}`);
    const out: Record<string, any> = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    const tokens = Object.values(out.tokens as Record<string, string>);

    // ── the calls themselves: same outcome on every transport ─────────────
    expect(out.calls_before.status, JSON.stringify(out.calls_before)).toBe(200);
    expect(out.calls_before.body.rows).toEqual([]);
    expect(out.http_ok.status, JSON.stringify(out.http_ok)).toBe(200);
    expect(out.mcp_ok.isError, JSON.stringify(out.mcp_ok)).toBe(false);
    expect(out.cli_kb_ok.exit, JSON.stringify(out.cli_kb_ok)).toBe(0);
    expect(out.mcp_ok.value).toEqual(out.http_ok.body);
    expect(out.cli_kb_ok.value).toEqual(out.http_ok.body);

    expect(out.http_err.status, JSON.stringify(out.http_err)).toBe(400);
    expect(out.http_err.body.code).toBe("invalid_reference");
    expect(out.mcp_err.isError, JSON.stringify(out.mcp_err)).toBe(true);
    expect(out.mcp_err.value).toEqual(out.http_err.body);
    expect(out.cli_kb_err.exit, JSON.stringify(out.cli_kb_err)).not.toBe(0);
    expect(out.cli_kb_err.value).toEqual(out.http_err.body);

    expect(out.mcp_recall.status, JSON.stringify(out.mcp_recall)).toBe(200);
    expect(out.mcp_stats.isError, JSON.stringify(out.mcp_stats)).toBe(false);
    expect(out.cli_stats.exit, JSON.stringify(out.cli_stats)).toBe(0);

    // ── the audit trail ───────────────────────────────────────────────────
    expect(out.calls_after.status, JSON.stringify(out.calls_after)).toBe(200);
    const rows = out.calls_after.body.rows as Row[];
    const byTool = (tool: string) => rows.filter((r) => r.tool === tool);
    const meta = (r: Row) => JSON.parse(r.h_metadata ?? "null") as Record<string, any>;
    const agent = (r: Row) => (JSON.parse(r.internal_metadata ?? "null") as any)?.transport?.user_agent ?? null;

    // Exactly the MCP-originated calls (direct and via the CLI's MCP leg).
    // HTTP and the CLI's kb leg (which is HTTP) wrote nothing, and neither
    // did the two HTTP audit reads.
    expect(rows.map((r) => r.tool).sort()).toEqual(
      ["call_stats", "call_stats", "kb_getContext", "kb_listNodes", "recall", "recall"].sort(),
    );
    // `total` is an Int64 carried as decimal text on the wire.
    expect(Number(out.calls_after.body.total)).toBe(6);

    const [okRow] = byTool("kb_listNodes");
    expect(okRow!.status).toBe("ok");
    expect(agent(okRow!)).toBe(out.userAgent);
    const [errRow] = byTool("kb_getContext");
    expect(errRow!.status).toBe("error");
    // The error row carries the same governed envelope the caller saw.
    expect(meta(errRow!).result).toContain("invalid_reference");

    // Direct MCP vs the CLI's MCP leg: same tool, same status, same redacted
    // input and the same attribution; only the transport user agent differs.
    for (const tool of ["recall", "call_stats"]) {
      const pair = byTool(tool);
      expect(pair.length).toBe(2);
      const [a, b] = pair as [Row, Row];
      expect(a.status).toBe(b.status);
      expect(meta(a).input).toBe(meta(b).input);
      expect(meta(a).auth).toEqual(meta(b).auth);
      expect([agent(a), agent(b)].sort()).toEqual([out.userAgent, "arra-v4-cli"].sort());
    }
    for (const row of byTool("recall")) {
      expect(meta(row).input).toContain("token=[REDACTED]");
      expect(meta(row).input).not.toContain("hunter2");
    }

    // Redaction on EVERY row: no bearer token, no raw header, and the
    // wrapper-owned block has exactly the §4 keys.
    for (const row of rows) {
      const text = JSON.stringify(row);
      for (const token of tokens) expect(text.includes(token)).toBe(false);
      expect(text.toLowerCase().includes("bearer ")).toBe(false);
      expect(Object.keys(meta(row)).sort()).toEqual(["auth", "input", "result"]);
      expect(Object.keys(meta(row).auth).sort()).toEqual(["credential_id", "policy_version", "principal_id"]);
    }

    // ── connections (R5 / R19): one row per MCP-calling credential ────────
    expect(out.conns_after.status, JSON.stringify(out.conns_after)).toBe(200);
    const conns = out.conns_after.body.rows as Record<string, any>[];
    // The fold key is (workspace, method, principal, label) by design
    // (`mcp/connections.ts` foldId): one row per credential PER CLIENT, so the
    // direct MCP client and the CLI's MCP leg are two rows of one credential.
    const toolCalls = (principal: string) =>
      conns.filter((c) => c.principal === principal).reduce((n, c) => n + Number(c.tool_calls), 0);
    expect(conns.map((c) => `${c.principal}|${c.label}`).sort()).toEqual(
      [`cred-audit|${out.userAgent}`, "cred-audit|arra-v4-cli", `cred-write|${out.userAgent}`, "cred-write|arra-v4-cli"].sort(),
    );
    for (const c of conns) expect(c.method).toBe("bearer");
    // Tool calls counted per credential: MCP-originated only, HTTP/kb-CLI never.
    expect(toolCalls("cred-write")).toBe(4);
    expect(toolCalls("cred-audit")).toBe(2);
    for (const token of tokens) expect(JSON.stringify(conns).includes(token)).toBe(false);
  },
  TEST_TIMEOUT_MS,
);
