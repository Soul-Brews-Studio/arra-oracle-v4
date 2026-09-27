// #31 audit parity for the LEGACY HTTP memory routes, live (legacy-audit
// slice, 2026-09-27). `transport-audit-parity.test.ts` and
// `transport-audit-refusals.test.ts` cover the knowledge route; this file
// covers `/api/memories`, `/api/search` and `/api/health`, on a REAL listening
// server over a fresh dataset (`fixtures/transport-v1/live-server/child.ts`).
//
// What is asserted, and why:
//   - #31's TODO asks for "success/failure audit consistently across all
//     transports". Each legacy route has an MCP twin that has always been
//     audited (`auth/service.ts` `runMcp`): GET /api/memories is
//     `list_memories`, GET /api/search is `recall`, POST /api/memories is
//     `remember`, GET /api/health is `bank_info`. An ADMITTED legacy call now
//     writes the row its twin writes: the same tool, status, redacted input
//     (the MCP argument shape), `session_name`, auth attribution and user
//     agent, and for the reads the same result. `remember` and `bank_info`
//     answer each transport with a different shape, so there each row records
//     what ITS caller received, and every other column is equal.
//   - An admitted call that fails validation is audited on both transports
//     with the same result text.
//   - A request refused before admission (no header, a bogus token, a
//     credential with no grant on the route workspace) writes no row.
//   - The global maintenance routes (`/api/backfill`, `/api/reindex`) have no
//     MCP twin and no workspace to file a row under (`mcp_calls.workspace_name`
//     is non-null), so an admitted call writes no row: pinned, documented.
//   - A knowledge body that is not an object (`[]`) is audited with the same
//     text on both transports ("payload must be an object").

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

const listCalls = { workspace_name: ALPHA, after_id: null, limit: 200, tool: null, status: null, include_total: true };
const listConns = { workspace_name: ALPHA, after_id: null, limit: 200, include_total: true };
// The remember arguments; `api_key` is secret-shaped, so the writer redacts it.
const memory = { name: "legacy-note", content: "hello legacy audit", session_name: "s-legacy", api_key: "sk-not-a-real-key" };

// Admitted and workspace-scoped before `settle`: calls_before, 4 ok pairs (8),
// 3 failing pairs (6) and the `[]` pair (2). The admitted global reindex has
// no workspace, so it folds nothing.
const FOLDED_BEFORE_SETTLE = 17;
const PER_CALL = new Set(["id", "duration_ms", "created_at"]);

type Row = { tool: string; status: string; h_metadata: string | null; [key: string]: unknown };

runIt(
  "admitted legacy HTTP memory calls write the row their MCP twin writes; unadmitted and global ones write none",
  async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    cleanups.push(fixture.cleanup);
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-audit-legacy-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const legacy = (label: string, token: string, httpMethod: "GET" | "POST", path: string, body?: unknown) =>
      ({ label, transport: "legacy", token, bank: "alpha", method: "", httpMethod, path, body });
    const mcp = (label: string, token: string, tool: string, args: unknown) =>
      ({ label, transport: "mcp", token, bank: "alpha", method: tool, body: args });
    const http = (label: string, token: string, method: string, body: unknown) =>
      ({ label, transport: "http", token, bank: "alpha", method, body });
    const steps = [
      http("calls_before", "audit", "listMcpCalls", listCalls),
      // ── admitted and run: one row each ──────────────────────────────
      legacy("http_remember", "write", "POST", "/api/memories", { workspace_name: ALPHA, ...memory }),
      // The reads run between the two writes, so exactly one memory exists
      // and both transports see the same rows (tied scores reorder freely).
      legacy("http_list", "write", "GET", "/api/memories?bank={alpha}&limit=5"),
      mcp("mcp_list", "write", "list_memories", { limit: 5 }),
      legacy("http_recall", "write", "GET", "/api/search?bank={alpha}&q=legacy&limit=5"),
      mcp("mcp_recall", "write", "recall", { query: "legacy", limit: 5 }),
      mcp("mcp_remember", "write", "remember", memory),
      legacy("http_bank_info", "diag", "GET", "/api/health?bank={alpha}"),
      mcp("mcp_bank_info", "diag", "bank_info", {}),
      // ── admitted, then refused by validation: audited on both ───────
      legacy("http_recall_blank", "write", "GET", "/api/search?bank={alpha}&q=%20"),
      mcp("mcp_recall_blank", "write", "recall", { query: " " }),
      legacy("http_list_zero", "write", "GET", "/api/memories?bank={alpha}&limit=0"),
      mcp("mcp_list_zero", "write", "list_memories", { limit: 0 }),
      legacy("http_remember_blank", "write", "POST", "/api/memories", { workspace_name: ALPHA, name: "x", content: "   " }),
      mcp("mcp_remember_blank", "write", "remember", { name: "x", content: "   " }),
      // ── a knowledge body that is not an object ───────────────────────
      http("http_kb_array", "write", "listNodes", []),
      mcp("mcp_kb_array", "write", "kb_listNodes", { payload: [] }),
      // ── refused before admission: no row ─────────────────────────────
      legacy("none_list", "none", "GET", "/api/memories?bank={alpha}"),
      legacy("bogus_recall", "bogus", "GET", "/api/search?bank={alpha}&q=legacy"),
      legacy("foreign_remember", "other", "POST", "/api/memories", { workspace_name: ALPHA, ...memory }),
      legacy("write_health", "write", "GET", "/api/health?bank={alpha}"),
      // ── global maintenance: admitted, but no workspace to file under ─
      legacy("maint_reindex", "maint", "POST", "/api/reindex", {}),
      { label: "settle", transport: "settle", token: "audit", bank: "alpha", method: "", ms: scaledMs(15_000), folds: FOLDED_BEFORE_SETTLE },
      http("conns_after", "audit", "listConnections", listConns),
      http("calls_after", "audit", "listMcpCalls", listCalls),
    ];
    const result = await runGated(fixture.datasetRoot, CHILD, [
      fixture.datasetRoot,
      workDir,
      JSON.stringify({ banks: { alpha: ALPHA, beta: BETA }, steps }),
    ]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(-2000)}`);
    const out: Record<string, any> = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    const tokens = Object.values(out.tokens as Record<string, string>);
    const show = (label: string) => `${label}: ${JSON.stringify(out[label])}`;

    // ── the responses, unchanged by the audit ────────────────────────────
    expect(out.calls_before.body.rows, show("calls_before")).toEqual([]);
    expect(out.http_remember.status, show("http_remember")).toBe(201);
    expect(out.mcp_remember.isError, show("mcp_remember")).toBe(false);
    expect(out.http_list.status, show("http_list")).toBe(200);
    expect(out.mcp_list.value, show("mcp_list")).toEqual(out.http_list.body);
    expect(out.http_recall.status, show("http_recall")).toBe(200);
    expect(out.mcp_recall.value, show("mcp_recall")).toEqual(out.http_recall.body);
    expect(out.http_bank_info.status, show("http_bank_info")).toBe(200);
    for (const label of ["http_recall_blank", "http_list_zero", "http_remember_blank"]) {
      expect(out[label], label).toEqual({ status: 400, body: { error: "bad request" } });
    }
    expect(out.http_kb_array, show("http_kb_array")).toEqual({ status: 400, body: { error: "bad request" } });
    expect(out.mcp_kb_array, show("mcp_kb_array")).toEqual({ status: 200, isError: true, value: "payload must be an object" });
    expect(out.none_list.status).toBe(401);
    expect(out.bogus_recall.status).toBe(401);
    expect(out.foreign_remember.status).toBe(403);
    expect(out.write_health.status).toBe(403);
    expect(out.maint_reindex.status, show("maint_reindex")).toBe(200);

    // ── the audit trail ───────────────────────────────────────────────────
    expect(out.calls_after.status, show("calls_after")).toBe(200);
    const rows = out.calls_after.body.rows as Row[];
    const meta = (r: Row) => JSON.parse(r.h_metadata ?? "null") as Record<string, any>;
    expect(rows.map((r) => `${r.tool}:${r.status}`).sort(), JSON.stringify(rows.map((r) => r.tool))).toEqual(
      [
        "kb_listMcpCalls:ok",
        "kb_listConnections:ok",
        ...["remember:ok", "list_memories:ok", "recall:ok", "bank_info:ok"].flatMap((t) => [t, t]),
        ...["recall:error", "list_memories:error", "remember:error", "kb_listNodes:error"].flatMap((t) => [t, t]),
      ].sort(),
    );

    /** The two rows of one call pair: equal in every column but identity,
     *  timing and, where `sameResult` is false, `h_metadata.result`. */
    const pair = (tool: string, status: string, sameResult: boolean) => {
      const both = rows.filter((r) => r.tool === tool && r.status === status);
      expect(both.length, `${tool}:${status}`).toBe(2);
      const [a, b] = both as [Row, Row];
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
      for (const column of Object.keys(a)) {
        if (PER_CALL.has(column)) continue;
        if (column === "h_metadata") {
          const [ma, mb] = [meta(a), meta(b)];
          if (!sameResult) {
            delete ma.result;
            delete mb.result;
          }
          expect(mb, `${tool} ${column}`).toEqual(ma);
        } else if (column === "internal_metadata") {
          expect(JSON.parse(String(b[column] ?? "null")), column).toEqual(JSON.parse(String(a[column] ?? "null")));
        } else {
          expect(b[column], `${tool} ${column}`).toEqual(a[column]);
        }
      }
      expect(a.workspace_name).toBe(ALPHA);
      return [a, b] as const;
    };
    /** The row whose result is what `body` says its caller received. */
    const resultOf = (both: readonly [Row, Row], body: unknown) =>
      both.find((r) => JSON.stringify(JSON.parse(meta(r).result)) === JSON.stringify(body));

    const remember = pair("remember", "ok", false);
    expect(meta(remember[0]).input).toBe(JSON.stringify({ ...memory, api_key: "[REDACTED]" }));
    expect(remember[0].session_name).toBe("s-legacy");
    expect(meta(remember[0]).auth).toEqual({ principal_id: "alpha-write", credential_id: "cred-write", policy_version: expect.any(String) });
    // Each row records what its own caller received.
    expect(resultOf(remember, out.http_remember.body), "http remember result").toBeDefined();
    expect(resultOf(remember, out.mcp_remember.value), "mcp remember result").toBeDefined();

    const list = pair("list_memories", "ok", true);
    expect(meta(list[0]).input).toBe(JSON.stringify({ limit: 5 }));
    const recall = pair("recall", "ok", true);
    expect(meta(recall[0]).input).toBe(JSON.stringify({ query: "legacy", limit: 5 }));
    const bankInfo = pair("bank_info", "ok", false);
    expect(meta(bankInfo[0]).input).toBe(JSON.stringify({}));
    expect(meta(bankInfo[0]).auth.credential_id).toBe("cred-diag");
    expect(resultOf(bankInfo, out.http_bank_info.body), "http bank_info result").toBeDefined();
    expect(resultOf(bankInfo, out.mcp_bank_info.value), "mcp bank_info result").toBeDefined();

    const [blank] = pair("recall", "error", true);
    expect(meta(blank).result).toBe("query must be a non-blank string");
    const [zero] = pair("list_memories", "error", true);
    expect(meta(zero).result).toBe("limit must be a safe integer between 1 and 1000");
    expect(meta(zero).input).toBe(JSON.stringify({ limit: 0 }));
    const [badWrite] = pair("remember", "error", true);
    expect(meta(badWrite).result).toBe("content must be a non-blank string");
    const [array] = pair("kb_listNodes", "error", true);
    expect(meta(array).result).toBe("payload must be an object");
    expect(meta(array).input).toBe(JSON.stringify({ payload: [] }));

    for (const row of rows) {
      const text = JSON.stringify(row);
      for (const token of tokens) expect(text.includes(token)).toBe(false);
      expect(Object.keys(meta(row)).sort()).toEqual(["auth", "input", "result"]);
      expect(JSON.parse(String(row.internal_metadata))).toEqual({ transport: { user_agent: out.userAgent } });
    }

    // ── connections: folded for the admitted, workspace-scoped calls only ─
    expect(out.settle.requests, show("settle")).toBe(FOLDED_BEFORE_SETTLE);
    const conns = out.conns_after.body.rows as Record<string, any>[];
    expect(conns.map((c) => c.principal).sort()).toEqual(["cred-audit", "cred-diag", "cred-write"]);
    const requests = (principal: string) =>
      conns.filter((c) => c.principal === principal).reduce((n, c) => n + Number(c.requests), 0);
    expect(requests("cred-write")).toBe(14);
    expect(requests("cred-diag")).toBe(2);
    expect(requests("cred-audit")).toBe(1);
  },
  TEST_TIMEOUT_MS,
);
