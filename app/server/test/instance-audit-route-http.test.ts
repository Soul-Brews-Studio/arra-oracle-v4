// #31 R25 (Nat D4b) fix round 2 -- the round-2 verifier found the bug lived
// entirely at the HTTP boundary: `readInstanceAuditRows` unit-tested fine
// (called directly with `{}`), but `app.instanceAuditRoute.ts` turned every
// ABSENT `route`/`outcome` query param into the literal string `"null"`
// (`URLSearchParams.get` returns `null`, and the reader only skips a filter
// when it is `!== undefined`), so `GET /api/instance-audit` with no filters,
// or only one of the two, always answered `{rows:[],next_cursor:null}` even
// with rows present. This file exercises the REAL route on a REAL listening
// server, never calling `service.readInstanceAudit` directly, so it would
// have caught that gap the first time.
//
// Runs in a subprocess (Bun.spawn) because `ARRA_DATA_DIR` / `openInstanceAuditTable`
// memoize a connection at module-import time -- the same reason every other
// instance-audit test in this suite spawns rather than importing in-process
// (see `instance-audit-reader.test.ts`'s header).

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTimeout } from "./helpers/timing.testTimeout";

const TEST_TIMEOUT_MS = testTimeout(60_000);
const SRC = join(import.meta.dir, "..", "src");

const NOT_BEFORE = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

const OPERATOR_SECRET = "4444444444444444444444444444444444444444444444444444444444444444".slice(0, 64);
const WORKSPACE_SECRET = "5555555555555555555555555555555555555555555555555555555555555555".slice(0, 64);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

async function policyDocument() {
  return {
    version: "arra-auth/v1",
    principals: [
      { id: "op-backfill", disabled: false, workspaces: [], global_actions: ["maintenance:backfill"] },
      {
        id: "workspace-only",
        disabled: false,
        workspaces: [{ name: "alpha", actions: ["content:read", "audit:read"] }],
        global_actions: [],
      },
    ],
    credentials: [
      { id: "cred-op", principal_id: "op-backfill", sha256: await sha256Hex(OPERATOR_SECRET), not_before: NOT_BEFORE, expires_at: EXPIRES_AT, revoked: false },
      { id: "cred-ws", principal_id: "workspace-only", sha256: await sha256Hex(WORKSPACE_SECRET), not_before: NOT_BEFORE, expires_at: EXPIRES_AT, revoked: false },
    ],
  };
}

/** Starts a REAL server on `origin`, mounting the REAL `createApp` (so the
 *  REAL route file is exercised), seeds `n` backfill rows via the REAL
 *  appendInstanceAuditRow writer, runs `script` (may `fetch(...)`), then
 *  prints one JSON line and exits. */
async function runHttp(dataDir: string, policyPath: string, script: string): Promise<any> {
  const body = `
    const { createOperationService } = await import(${JSON.stringify(join(SRC, "auth", "service.createOperationService.ts"))});
    const { createApp } = await import(${JSON.stringify(join(SRC, "app.createApp.ts"))});
    const { createMcpAdapter } = await import(${JSON.stringify(join(SRC, "mcp", "index.ts"))});
    const { appendInstanceAuditRow } = await import(${JSON.stringify(join(SRC, "audit", "instanceAudit.appendInstanceAuditRow.ts"))});
    const deps = {
      logInstanceAudit: appendInstanceAuditRow,
      insert: async () => { throw new Error("unused"); },
      list: async () => [],
      searchText: async () => ({ match: "ngram", rows: [] }),
      searchVector: async () => [],
      getById: async () => null,
      stats: async () => ({}),
      backfill: async () => ({}),
      ensureFtsIndex: async () => [],
      embedHealth: async () => ({ ok: false, model: "scratch", dims: 384, detail: "scratch" }),
      recentCalls: async () => [],
      aggregateCalls: async () => ({}),
      logCall: async () => {},
    };
    const service = createOperationService({ policyPath: ${JSON.stringify(policyPath)} }, deps);
    const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
    const port = Number(probe.port);
    probe.stop(true);
    const origin = "http://127.0.0.1:" + port;
    const app = createApp({ origin }, service, createMcpAdapter(service));
    const server = Bun.serve({ port, fetch: (request) => app.handle(request) });
    for (let i = 0; i < 3; i++) {
      await appendInstanceAuditRow({
        principal_id: "op-backfill",
        route: "/api/backfill",
        action: "maintenance:backfill",
        outcome: "admitted",
        status: "ok",
        input: { batch: i },
        started_at: 1000 + i,
        finished_at: 1000 + i + 5,
        request_id: "req_seed_" + i,
      });
    }
    const get = (path, token) =>
      fetch(origin + path, { headers: token ? { Authorization: "Bearer " + token } : {} })
        .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    ${script}
    server.stop(true);
  `;
  const proc = Bun.spawn(["bun", "-e", body], {
    env: { ...process.env, ARRA_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`subprocess exited ${code}: ${stderr.slice(-4000)}\n${stdout}`);
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

async function scratch() {
  const dataDir = await mkdtemp(join(tmpdir(), "arra-v4-audit-http-"));
  const policyPath = join(dataDir, "policy.json");
  await writeFile(policyPath, JSON.stringify(await policyDocument()), { encoding: "utf-8", mode: 0o600 });
  return { dataDir, policyPath, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

describe("GET /api/instance-audit over a real listening server (#31 R25 fix round 2)", () => {
  test("no filters returns the seeded rows, not an empty page", async () => {
    const s = await scratch();
    try {
      const out = await runHttp(
        s.dataDir,
        s.policyPath,
        `
        const r = await get("/api/instance-audit", ${JSON.stringify(OPERATOR_SECRET)});
        console.log(JSON.stringify(r));
        `,
      );
      expect(out.status).toBe(200);
      // 3 seeded + this request's own self-audit row = 4, but the seeded
      // backfill rows must be present regardless of the self-audit count.
      expect(out.body.rows.length).toBeGreaterThanOrEqual(3);
      expect(out.body.rows.some((r: any) => r.route === "/api/backfill")).toBe(true);
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("only the route filter present (outcome absent) still returns rows", async () => {
    const s = await scratch();
    try {
      const out = await runHttp(
        s.dataDir,
        s.policyPath,
        `
        const r = await get("/api/instance-audit?route=/api/backfill", ${JSON.stringify(OPERATOR_SECRET)});
        console.log(JSON.stringify(r));
        `,
      );
      expect(out.status).toBe(200);
      expect(out.body.rows.length).toBeGreaterThanOrEqual(3);
      for (const row of out.body.rows) expect(row.route).toBe("/api/backfill");
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("only the outcome filter present (route absent) still returns rows", async () => {
    const s = await scratch();
    try {
      const out = await runHttp(
        s.dataDir,
        s.policyPath,
        `
        const r = await get("/api/instance-audit?outcome=admitted", ${JSON.stringify(OPERATOR_SECRET)});
        console.log(JSON.stringify(r));
        `,
      );
      expect(out.status).toBe(200);
      expect(out.body.rows.length).toBeGreaterThanOrEqual(3);
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("both filters together still work (this was the only combination that worked before the fix)", async () => {
    const s = await scratch();
    try {
      const out = await runHttp(
        s.dataDir,
        s.policyPath,
        `
        const r = await get("/api/instance-audit?route=/api/backfill&outcome=admitted", ${JSON.stringify(OPERATOR_SECRET)});
        console.log(JSON.stringify(r));
        `,
      );
      expect(out.status).toBe(200);
      expect(out.body.rows.length).toBeGreaterThanOrEqual(3);
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a workspace-scoped principal is refused over HTTP", async () => {
    const s = await scratch();
    try {
      const out = await runHttp(
        s.dataDir,
        s.policyPath,
        `
        const r = await get("/api/instance-audit", ${JSON.stringify(WORKSPACE_SECRET)});
        console.log(JSON.stringify(r));
        `,
      );
      expect(out.status).toBe(403);
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("anonymous is refused over HTTP", async () => {
    const s = await scratch();
    try {
      const out = await runHttp(
        s.dataDir,
        s.policyPath,
        `
        const r = await get("/api/instance-audit", null);
        console.log(JSON.stringify(r));
        `,
      );
      expect(out.status).toBe(401);
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("an invalid cursor is 400, not a silent restart at page 1", async () => {
    const s = await scratch();
    try {
      const out = await runHttp(
        s.dataDir,
        s.policyPath,
        `
        const r = await get("/api/instance-audit?cursor=garbage", ${JSON.stringify(OPERATOR_SECRET)});
        console.log(JSON.stringify(r));
        `,
      );
      expect(out.status).toBe(400);
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("limit=0 and limit=abc both 400 (previously inconsistent: 0 was 200, abc was 400)", async () => {
    const s = await scratch();
    try {
      const out = await runHttp(
        s.dataDir,
        s.policyPath,
        `
        const zero = await get("/api/instance-audit?limit=0", ${JSON.stringify(OPERATOR_SECRET)});
        const abc = await get("/api/instance-audit?limit=abc", ${JSON.stringify(OPERATOR_SECRET)});
        console.log(JSON.stringify({ zero: zero.status, abc: abc.status }));
        `,
      );
      expect(out.zero).toBe(400);
      expect(out.abc).toBe(400);
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("same-millisecond rows are never dropped across a page boundary (cursor is startedAt+id)", async () => {
    const s = await scratch();
    try {
      const out = await runHttp(
        s.dataDir,
        s.policyPath,
        `
        // 4 rows sharing one started_at, on top of the 3 seeded rows above.
        for (let i = 0; i < 4; i++) {
          await appendInstanceAuditRow({
            principal_id: "op-backfill",
            route: "/api/reindex",
            action: "maintenance:reindex",
            outcome: "admitted",
            status: "ok",
            input: { i },
            started_at: 5000,
            finished_at: 5000,
            request_id: "req_tie_" + i,
          });
        }
        const p1 = await get("/api/instance-audit?route=/api/reindex&limit=2", ${JSON.stringify(OPERATOR_SECRET)});
        const p2 = await get("/api/instance-audit?route=/api/reindex&limit=2&cursor=" + encodeURIComponent(p1.body.next_cursor), ${JSON.stringify(OPERATOR_SECRET)});
        console.log(JSON.stringify({
          p1n: p1.body.rows.length, p1cursor: p1.body.next_cursor,
          p2n: p2.body.rows.length, p2cursor: p2.body.next_cursor,
        }));
        `,
      );
      expect(out.p1n).toBe(2);
      expect(out.p1cursor).not.toBeNull();
      // Round-2 verifier finding: a started_at-only cursor made this 0/null,
      // permanently losing the other 2 same-millisecond rows.
      expect(out.p2n).toBe(2);
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
