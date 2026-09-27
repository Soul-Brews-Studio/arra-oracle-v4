// #31 cross-transport AUDIT PARITY, live (acceptance-criteria slice,
// 2026-09-26; fix round 2026-09-27). The same method called over HTTP, MCP and
// the real CLI, on a REAL listening server over a fresh writer-gated dataset
// (`fixtures/transport-v1/live-server/child.ts`), then the audit trail read
// back over the wire.
//
// What is asserted, and why:
//   - #31 TODO5 ("authz/limits/redaction/audit across transports") and R8
//     (docs/overnight/DECISIONS.md: keep #31's full contract, do not narrow
//     it). R5: `mcp_calls` and `connections` are "operational audit written
//     on every request". So an ADMITTED call lands in the same table whichever
//     transport carried it: MCP `tools/call`, `POST /api/knowledge/:bank/
//     :method`, and the CLI (whose `kb <method>` leg forwards to that HTTP
//     route and whose legacy commands call MCP tools). One row per call, ok
//     AND error, with the same tool name (`kb_<method>`), the same status,
//     the same redacted input/result and the same attribution; only the
//     transport user agent differs. The first round of this file asserted
//     the opposite (HTTP writes nothing), which was the #31 gap, not a rule.
//   - R5 / R19: rows are read by `listMcpCalls`/`listConnections` from the
//     operations root; `connections.method` is `bearer`, `principal` the
//     credential id.
//   - Redaction (authorization-integration-v1.md §4 + `mcp/calls.ts`): no
//     bearer token anywhere in a row; the `h_metadata` block is exactly
//     {input, result, auth}; a secret-shaped argument is redacted the same
//     way whichever client sent it.

import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, PYTHON, runGated } from "./helpers/publication-fixture";
import { scaledMs } from "./helpers/timing.scaledMs";
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
// The same secret inside a knowledge payload, sent over HTTP, MCP and the CLI.
const secretNodes = { ...listNodes, type_term: SECRET_QUERY };
const listCalls = { workspace_name: ALPHA, after_id: null, limit: 200, tool: null, status: null, include_total: true };
const listConns = { workspace_name: ALPHA, after_id: null, limit: 200, include_total: true };

// Every admitted request before `settle`: calls_before, 3 knowledge calls
// (ok, error, secret) x 3 transports, 2 recalls and 2 call-stats.
const FOLDED_BEFORE_SETTLE = 14;

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
      // Baseline: the trail starts empty. This read is itself audited, but
      // its row is appended after it answers, so it cannot see itself.
      { label: "calls_before", transport: "http", token: "audit", bank: "alpha", method: "listMcpCalls", body: listCalls },
      // ok: the same knowledge method on all three transports.
      { label: "http_ok", transport: "http", token: "write", bank: "alpha", method: "listNodes", body: listNodes },
      { label: "mcp_ok", transport: "mcp", token: "write", bank: "alpha", method: "kb_listNodes", body: { payload: listNodes } },
      { label: "cli_kb_ok", transport: "cli", token: "write", bank: "alpha", method: "", argv: kbArgv("listNodes", listNodes) },
      // error: the same refused request on all three transports.
      { label: "http_err", transport: "http", token: "write", bank: "alpha", method: "getContext", body: badContext },
      { label: "mcp_err", transport: "mcp", token: "write", bank: "alpha", method: "kb_getContext", body: { payload: badContext } },
      { label: "cli_kb_err", transport: "cli", token: "write", bank: "alpha", method: "", argv: kbArgv("getContext", badContext) },
      // A secret-shaped knowledge argument on all three transports.
      { label: "http_secret", transport: "http", token: "write", bank: "alpha", method: "listNodes", body: secretNodes },
      { label: "mcp_secret", transport: "mcp", token: "write", bank: "alpha", method: "kb_listNodes", body: { payload: secretNodes } },
      { label: "cli_kb_secret", transport: "cli", token: "write", bank: "alpha", method: "", argv: kbArgv("listNodes", secretNodes) },
      // The CLI's MCP leg vs a direct MCP call, same tool and arguments.
      { label: "mcp_recall", transport: "mcp", token: "write", bank: "alpha", method: "recall", body: recallArgs },
      { label: "cli_recall", transport: "cli", token: "write", bank: "alpha", method: "", argv: ["recall", "--query", SECRET_QUERY, "--mode", "text", "--limit", "10"] },
      { label: "mcp_stats", transport: "mcp", token: "audit", bank: "alpha", method: "call_stats", body: {} },
      { label: "cli_stats", transport: "cli", token: "audit", bank: "alpha", method: "", argv: ["call-stats"] },
      // The connection fold is fire-and-forget (composition.ts): wait until
      // every audited request above is folded, read off the table directly.
      { label: "settle", transport: "settle", token: "audit", bank: "alpha", method: "", ms: scaledMs(15_000), folds: FOLDED_BEFORE_SETTLE },
      // Connections first: `mcp_calls` rows are awaited before the response,
      // folds are not, so reading the log second makes both reads exact.
      { label: "conns_after", transport: "http", token: "audit", bank: "alpha", method: "listConnections", body: listConns },
      { label: "calls_after", transport: "http", token: "audit", bank: "alpha", method: "listMcpCalls", body: listCalls },
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

    expect(out.mcp_secret.value, JSON.stringify(out.mcp_secret)).toEqual(out.http_secret.body);
    expect(out.cli_kb_secret.value, JSON.stringify(out.cli_kb_secret)).toEqual(out.http_secret.body);

    expect(out.mcp_recall.status, JSON.stringify(out.mcp_recall)).toBe(200);
    expect(out.mcp_stats.isError, JSON.stringify(out.mcp_stats)).toBe(false);
    expect(out.cli_stats.exit, JSON.stringify(out.cli_stats)).toBe(0);

    // ── the audit trail ───────────────────────────────────────────────────
    expect(out.calls_after.status, JSON.stringify(out.calls_after)).toBe(200);
    const rows = out.calls_after.body.rows as Row[];
    const byTool = (tool: string) => rows.filter((r) => r.tool === tool);
    const meta = (r: Row) => JSON.parse(r.h_metadata ?? "null") as Record<string, any>;
    const agent = (r: Row) => (JSON.parse(r.internal_metadata ?? "null") as any)?.transport?.user_agent ?? null;

    // Every admitted call, on every transport: calls_before, the three
    // knowledge methods x HTTP/MCP/CLI, the recall and call-stats pairs, and
    // conns_after (audited before calls_after read). Only calls_after itself
    // is absent: its row is appended after it answers.
    expect(rows.map((r) => r.tool).sort()).toEqual(
      [
        "call_stats", "call_stats",
        "kb_getContext", "kb_getContext", "kb_getContext",
        "kb_listConnections", "kb_listMcpCalls",
        "kb_listNodes", "kb_listNodes", "kb_listNodes", "kb_listNodes", "kb_listNodes", "kb_listNodes",
        "recall", "recall",
      ].sort(),
    );
    // `total` is an Int64 carried as decimal text on the wire.
    expect(Number(out.calls_after.body.total)).toBe(15);

    // HTTP, MCP and the CLI's kb leg: one row each, same tool, same status,
    // same redacted input, same result and the same attribution; only the
    // transport user agent differs (the CLI names itself).
    const triple = (rowsOf: Row[], status: string) => {
      expect(rowsOf.length).toBe(3);
      for (const row of rowsOf) expect(row.status).toBe(status);
      const [a, ...rest] = rowsOf as [Row, ...Row[]];
      for (const b of rest) {
        expect(meta(b).input).toBe(meta(a).input);
        expect(meta(b).result).toBe(meta(a).result);
      }
      expect(rowsOf.map(agent).sort()).toEqual([out.userAgent, out.userAgent, "arra-v4-cli"].sort());
      return a;
    };
    const listed = byTool("kb_listNodes");
    const plain = listed.filter((r) => !meta(r).input.includes("REDACTED"));
    const secret = listed.filter((r) => meta(r).input.includes("REDACTED"));
    const okRow = triple(plain, "ok");
    expect(meta(okRow).input).toBe(JSON.stringify({ payload: listNodes }));
    for (const row of plain) expect(meta(row).auth).toEqual(meta(okRow).auth);
    const errRow = triple(byTool("kb_getContext"), "error");
    // The error row carries the same governed envelope the caller saw.
    expect(JSON.parse(meta(errRow).result)).toEqual(out.http_err.body);
    expect(meta(errRow).result).toContain("invalid_reference");
    // The secret-shaped argument: whatever its status, identical on all three
    // transports and redacted the same way.
    const secretRow = triple(secret, secret[0]!.status);
    expect(secretRow.status).toBe(out.http_secret.status === 200 ? "ok" : "error");
    for (const row of secret) {
      expect(meta(row).input).toContain("token=[REDACTED]");
      expect(JSON.stringify(row)).not.toContain("hunter2");
    }
    expect(byTool("kb_listMcpCalls").map(agent)).toEqual([out.userAgent]);
    expect(byTool("kb_listConnections").map(agent)).toEqual([out.userAgent]);

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

    // ── connections (R5 / R19): every audited request is folded ──────────
    expect(out.settle.requests, JSON.stringify(out.settle)).toBe(FOLDED_BEFORE_SETTLE);
    expect(out.conns_after.status, JSON.stringify(out.conns_after)).toBe(200);
    const conns = out.conns_after.body.rows as Record<string, any>[];
    // The fold key is (workspace, method, principal, label) by design
    // (`mcp/connections.ts` foldId): one row per credential PER CLIENT, so the
    // direct HTTP/MCP client and the CLI are two rows of one credential.
    const count = (principal: string, label: string, field: "requests" | "tool_calls") =>
      conns.filter((c) => c.principal === principal && c.label === label).reduce((n, c) => n + Number(c[field]), 0);
    expect(conns.map((c) => `${c.principal}|${c.label}`).sort()).toEqual(
      [`cred-audit|${out.userAgent}`, "cred-audit|arra-v4-cli", `cred-write|${out.userAgent}`, "cred-write|arra-v4-cli"].sort(),
    );
    for (const c of conns) expect(c.method).toBe("bearer");
    // HTTP and MCP from the test client: 3 knowledge methods x 2 + recall.
    expect(count("cred-write", out.userAgent, "requests")).toBe(7);
    // The CLI: 3 kb calls (HTTP leg) + recall (MCP leg).
    expect(count("cred-write", "arra-v4-cli", "requests")).toBe(4);
    // calls_before (HTTP) + call_stats (MCP); conns_after folds after it reads.
    expect(count("cred-audit", out.userAgent, "requests")).toBe(2);
    expect(count("cred-audit", "arra-v4-cli", "requests")).toBe(1);
    for (const c of conns) expect(Number(c.tool_calls)).toBe(Number(c.requests));
    for (const token of tokens) expect(JSON.stringify(conns).includes(token)).toBe(false);
  },
  TEST_TIMEOUT_MS,
);
