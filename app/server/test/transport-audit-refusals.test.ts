// #31 audit parity for REFUSED requests, live (acceptance-criteria slice,
// round 3, 2026-09-27). `transport-audit-parity.test.ts` covers admitted
// calls that succeed or fail in the kernel; this file covers the refusals
// around admission, on a REAL listening server over a fresh writer-gated
// dataset (`fixtures/transport-v1/live-server/child.ts`).
//
// What is asserted, and why:
//   - #31 TODO5 asks for "success/failure audit consistently across all
//     transports". A body naming another workspace than the route (an alpha
//     route, a beta body) is refused on both transports, but MCP checks it
//     AFTER admission (`mcp/index.ts`, inside the dispatch `runMcp` audits)
//     and so writes an error row. The HTTP route checked it BEFORE admission
//     and wrote nothing, so a cross-workspace attempt left a trail on one
//     transport only. Now an AUTHENTICATED and admitted body-scope refusal
//     writes the same row on both: same columns, same tool, status, redacted
//     input, result text and principal/credential attribution. Only `id`,
//     `duration_ms` and `created_at` may differ.
//   - A bound-peer refusal (#87 / R3: a `peers`-bound credential naming
//     another peer) is audited on both transports, with equal rows.
//   - A request refused before admission writes NO row on either transport:
//     no Authorization header, a token no credential hashes to (401), and a
//     valid credential with no grant on the route workspace (403), with or
//     without a body-scope mismatch. The HTTP status of every refusal is
//     pinned too, so aligning the audit changed no response.

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

const nodes = (workspace: string) => ({ workspace_name: workspace, after_id: null, limit: 5, include_total: false, type_term: null });
// The alpha route, a beta body: refused on both transports.
const crossBody = nodes(BETA);
// A `peers: ["peer-a"]`-bound credential naming peer-b (#87 / R3).
const otherPeer = { workspace_name: ALPHA, peer_name: "peer-b", session_name: "rc-main" };
const listCalls = { workspace_name: ALPHA, after_id: null, limit: 200, tool: null, status: null, include_total: true };
const listConns = { workspace_name: ALPHA, after_id: null, limit: 200, include_total: true };
// The text MCP has always audited and answered for this refusal.
const SCOPE_TEXT = "payload workspace_name must match the connected bank";

// Audited requests before `settle`: calls_before, the two body-scope
// refusals and the two bound-peer refusals. Nothing refused before admission.
const FOLDED_BEFORE_SETTLE = 5;
// Columns a row may differ in between two transports: identity and timing.
const PER_CALL = new Set(["id", "duration_ms", "created_at"]);

type Row = { tool: string; status: string; h_metadata: string | null; [key: string]: unknown };

runIt(
  "body-scope and bound-peer refusals write equal rows on HTTP and MCP; unadmitted requests write none",
  async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    cleanups.push(fixture.cleanup);
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-audit-refusals-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const http = (label: string, token: string, method: string, body: unknown) =>
      ({ label, transport: "http", token, bank: "alpha", method, body });
    const mcp = (label: string, token: string, method: string, payload: unknown) =>
      ({ label, transport: "mcp", token, bank: "alpha", method: `kb_${method}`, body: { payload } });
    const steps = [
      http("calls_before", "audit", "listMcpCalls", listCalls),
      // ── admitted, then refused: audited on both ──────────────────────
      http("http_scope", "write", "listNodes", crossBody),
      mcp("mcp_scope", "write", "listNodes", crossBody),
      http("http_bound", "bound", "getReadCursor", otherPeer),
      mcp("mcp_bound", "bound", "getReadCursor", otherPeer),
      // ── refused before admission: audited on neither ─────────────────
      http("http_none", "none", "listNodes", nodes(ALPHA)),
      http("http_none_scope", "none", "listNodes", crossBody),
      mcp("mcp_none", "none", "listNodes", nodes(ALPHA)),
      http("http_bogus", "bogus", "listNodes", nodes(ALPHA)),
      http("http_bogus_scope", "bogus", "listNodes", crossBody),
      mcp("mcp_bogus", "bogus", "listNodes", nodes(ALPHA)),
      mcp("mcp_bogus_scope", "bogus", "listNodes", crossBody),
      // Authenticated, but the credential holds no grant on alpha (403).
      http("http_foreign", "other", "listNodes", nodes(ALPHA)),
      http("http_foreign_scope", "other", "listNodes", crossBody),
      mcp("mcp_foreign", "other", "listNodes", nodes(ALPHA)),
      mcp("mcp_foreign_scope", "other", "listNodes", crossBody),
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

    // ── the responses, unchanged by the audit ────────────────────────────
    expect(out.calls_before.status, JSON.stringify(out.calls_before)).toBe(200);
    expect(out.calls_before.body.rows).toEqual([]);
    expect(out.http_scope, JSON.stringify(out.http_scope)).toEqual({ status: 400, body: { error: "bad request" } });
    expect(out.mcp_scope, JSON.stringify(out.mcp_scope)).toEqual({ status: 200, isError: true, value: SCOPE_TEXT });
    expect(out.http_bound.status, JSON.stringify(out.http_bound)).toBe(403);
    expect(out.mcp_bound.isError, JSON.stringify(out.mcp_bound)).toBe(true);
    expect(out.mcp_bound.value).toEqual(out.http_bound.body);
    expect(out.http_bound.body.path).toBe("/peer_name");
    // Unadmitted: HTTP keeps its order (a body-scope mismatch is 400 before
    // the credential is judged); MCP judges the credential before the body.
    for (const label of ["http_none", "http_bogus"]) expect(out[label].status, label).toBe(401);
    for (const label of ["http_none_scope", "http_bogus_scope", "http_foreign_scope"]) {
      expect(out[label], label).toEqual({ status: 400, body: { error: "bad request" } });
    }
    expect(out.http_foreign.status).toBe(403);
    for (const label of ["mcp_none", "mcp_bogus", "mcp_bogus_scope"]) expect(out[label].status, label).toBe(401);
    for (const label of ["mcp_foreign", "mcp_foreign_scope"]) expect(out[label].status, label).toBe(403);

    // ── the audit trail ───────────────────────────────────────────────────
    expect(out.calls_after.status, JSON.stringify(out.calls_after)).toBe(200);
    const rows = out.calls_after.body.rows as Row[];
    const meta = (r: Row) => JSON.parse(r.h_metadata ?? "null") as Record<string, any>;
    // Exactly the admitted requests: calls_before, the two refusal pairs and
    // conns_after. No unadmitted request, on either transport, left a row.
    expect(rows.map((r) => r.tool).sort()).toEqual(
      ["kb_getReadCursor", "kb_getReadCursor", "kb_listConnections", "kb_listMcpCalls", "kb_listNodes", "kb_listNodes"].sort(),
    );
    expect(Number(out.calls_after.body.total)).toBe(6);

    /** The two rows of one refusal: equal in every column but identity and timing. */
    const pair = (tool: string) => {
      const both = rows.filter((r) => r.tool === tool);
      expect(both.length).toBe(2);
      const [a, b] = both as [Row, Row];
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
      for (const column of Object.keys(a)) {
        if (PER_CALL.has(column)) continue;
        if (column === "h_metadata" || column === "internal_metadata") {
          expect(JSON.parse(String(b[column] ?? "null")), column).toEqual(JSON.parse(String(a[column] ?? "null")));
        } else {
          expect(b[column], column).toEqual(a[column]);
        }
      }
      expect(a.status).toBe("error");
      return a;
    };
    const scope = pair("kb_listNodes");
    expect(meta(scope).input).toBe(JSON.stringify({ payload: crossBody }));
    expect(meta(scope).result).toBe(SCOPE_TEXT);
    expect(meta(scope).auth.principal_id).toBe("alpha-write");
    expect(meta(scope).auth.credential_id).toBe("cred-write");
    // The row is filed under the route workspace the caller was admitted
    // for, never the workspace its body named.
    expect(scope.workspace_name).toBe(ALPHA);
    const bound = pair("kb_getReadCursor");
    expect(JSON.parse(meta(bound).result)).toEqual(out.http_bound.body);
    expect(meta(bound).auth.credential_id).toBe("cred-bound");

    for (const row of rows) {
      const text = JSON.stringify(row);
      for (const token of tokens) expect(text.includes(token)).toBe(false);
      expect(Object.keys(meta(row)).sort()).toEqual(["auth", "input", "result"]);
    }

    // ── connections: folded for the admitted requests only ───────────────
    expect(out.settle.requests, JSON.stringify(out.settle)).toBe(FOLDED_BEFORE_SETTLE);
    expect(out.conns_after.status, JSON.stringify(out.conns_after)).toBe(200);
    const conns = out.conns_after.body.rows as Record<string, any>[];
    const requests = (principal: string) =>
      conns.filter((c) => c.principal === principal).reduce((n, c) => n + Number(c.requests), 0);
    expect(conns.map((c) => c.principal).sort()).toEqual(["cred-audit", "cred-bound", "cred-write"]);
    expect(requests("cred-write")).toBe(2);
    expect(requests("cred-bound")).toBe(2);
    expect(requests("cred-audit")).toBe(1);
  },
  TEST_TIMEOUT_MS,
);
