// #31 R25 (Nat D4b): "the instance audit log is read only with an operator
// scope". Fresh reader for `instance_audit` -- companion to
// `transport-audit-instance.test.ts`, which pins the WRITE side only (the
// maintenance row) and never exercised a read. Each scenario runs in its own
// subprocess (Bun.spawn) because `storage.ts`'s `DATA_DIR` is a module-level
// singleton read once at import time -- the same reason every other
// instance-audit test in this suite spawns rather than importing in-process.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTimeout } from "./helpers/timing.testTimeout";

const TEST_TIMEOUT_MS = testTimeout(60_000);
const SRC = join(import.meta.dir, "..", "src");

const NOT_BEFORE = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

const TOKENS = {
  backfillOnly: {
    secret: "1111111111111111111111111111111111111111111111111111111111111111".slice(0, 64),
    sha256: "",
  },
  reindexOnly: {
    secret: "2222222222222222222222222222222222222222222222222222222222222222".slice(0, 64),
    sha256: "",
  },
  workspace: {
    secret: "3333333333333333333333333333333333333333333333333333333333333333".slice(0, 64),
    sha256: "",
  },
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

async function policyDocument() {
  TOKENS.backfillOnly.sha256 = await sha256Hex(TOKENS.backfillOnly.secret);
  TOKENS.reindexOnly.sha256 = await sha256Hex(TOKENS.reindexOnly.secret);
  TOKENS.workspace.sha256 = await sha256Hex(TOKENS.workspace.secret);
  return {
    version: "arra-auth/v1",
    principals: [
      { id: "op-backfill", disabled: false, workspaces: [], global_actions: ["maintenance:backfill"] },
      { id: "op-reindex", disabled: false, workspaces: [], global_actions: ["maintenance:reindex"] },
      {
        id: "workspace-only",
        disabled: false,
        workspaces: [{ name: "alpha", actions: ["content:read", "audit:read"] }],
        global_actions: [],
      },
    ],
    credentials: [
      { id: "cred-bf", principal_id: "op-backfill", sha256: TOKENS.backfillOnly.sha256, not_before: NOT_BEFORE, expires_at: EXPIRES_AT, revoked: false },
      { id: "cred-rx", principal_id: "op-reindex", sha256: TOKENS.reindexOnly.sha256, not_before: NOT_BEFORE, expires_at: EXPIRES_AT, revoked: false },
      { id: "cred-ws", principal_id: "workspace-only", sha256: TOKENS.workspace.sha256, not_before: NOT_BEFORE, expires_at: EXPIRES_AT, revoked: false },
    ],
  };
}

/** Runs `script` (a body, `return` its own JSON-able result) in a fresh
 *  subprocess pointed at a scratch `ARRA_DATA_DIR` and scratch policy file. */
async function runScript(dataDir: string, policyPath: string, body: string): Promise<any> {
  const script = `
    const { createOperationService } = await import("${join(SRC, "auth", "service.createOperationService.ts")}");
    const { appendInstanceAuditRow } = await import("${join(SRC, "audit", "instanceAudit.appendInstanceAuditRow.ts")}");
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
    ${body}
  `;
  const proc = Bun.spawn(["bun", "-e", script], {
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
  const dataDir = await mkdtemp(join(tmpdir(), "arra-v4-audit-reader-"));
  const policyPath = join(dataDir, "policy.json");
  await writeFile(policyPath, JSON.stringify(await policyDocument()), { encoding: "utf-8", mode: 0o600 });
  return { dataDir, policyPath, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

describe("instance audit reader (#31 R25)", () => {
  test("a fresh, never-written instance returns [] and no error", async () => {
    const s = await scratch();
    try {
      const out = await runScript(
        s.dataDir,
        s.policyPath,
        `
        const page = await service.readInstanceAudit("Bearer ${TOKENS.backfillOnly.secret}", {});
        console.log(JSON.stringify(page));
        `,
      );
      expect(out.rows).toEqual([]);
      expect(out.next_cursor).toBeNull();
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("an operator holding only maintenance:reindex is admitted (either global grant qualifies)", async () => {
    const s = await scratch();
    try {
      const out = await runScript(
        s.dataDir,
        s.policyPath,
        `
        const page = await service.readInstanceAudit("Bearer ${TOKENS.reindexOnly.secret}", {});
        console.log(JSON.stringify({ ok: true, rows: page.rows.length }));
        `,
      );
      expect(out.ok).toBe(true);
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a workspace-scoped principal with audit:read on a workspace is refused", async () => {
    const s = await scratch();
    try {
      const out = await runScript(
        s.dataDir,
        s.policyPath,
        `
        const { AuthDenied } = await import("${join(SRC, "auth", "service.createOperationService.ts")}");
        let code = null;
        try { await service.readInstanceAudit("Bearer ${TOKENS.workspace.secret}", {}); }
        catch (e) { code = e instanceof AuthDenied ? e.code : "not-AuthDenied"; }
        console.log(JSON.stringify({ code }));
        `,
      );
      expect(out.code).toBe("forbidden");
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("no credential at all (anonymous) is refused", async () => {
    const s = await scratch();
    try {
      const out = await runScript(
        s.dataDir,
        s.policyPath,
        `
        const { AuthDenied } = await import("${join(SRC, "auth", "service.createOperationService.ts")}");
        let code = null;
        try { await service.readInstanceAudit(null, {}); }
        catch (e) { code = e instanceof AuthDenied ? e.code : "not-AuthDenied"; }
        console.log(JSON.stringify({ code }));
        `,
      );
      expect(out.code).toBe("unauthenticated");
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("newest-first ordering, page bound, cursor paging, redaction and Thai round-trip", async () => {
    const s = await scratch();
    try {
      const out = await runScript(
        s.dataDir,
        s.policyPath,
        `
        for (let i = 0; i < 5; i++) {
          await appendInstanceAuditRow({
            principal_id: "op-backfill",
            route: "/api/backfill",
            action: "maintenance:backfill",
            outcome: "admitted",
            status: "ok",
            input: { batch: i, authorization: "Bearer some-secret-token", note: "สวัสดี ทดสอบ" },
            started_at: 1000 + i,
            finished_at: 1000 + i + 5,
            request_id: "req_" + i,
          });
        }
        const page1 = await service.readInstanceAudit("Bearer ${TOKENS.backfillOnly.secret}", { limit: 2 });
        const page2 = await service.readInstanceAudit("Bearer ${TOKENS.backfillOnly.secret}", { limit: 2, cursor: page1.next_cursor });
        console.log(JSON.stringify({ page1, page2 }));
        `,
      );
      // Newest-first: started_at 1004, 1003 on page1.
      expect(out.page1.rows.map((r: any) => r.started_at)).toEqual([1004, 1003]);
      expect(out.page1.rows.length).toBe(2);
      expect(out.page1.next_cursor).not.toBeNull();
      // Page bound respected.
      expect(out.page2.rows.map((r: any) => r.started_at)).toEqual([1002, 1001]);
      // Redaction preserved: the bearer token never appears in input_summary.
      for (const row of [...out.page1.rows, ...out.page2.rows]) {
        expect(row.input_summary).not.toContain("some-secret-token");
      }
      // Thai text round-trips through the redacted summary.
      expect(out.page1.rows[0].input_summary).toContain("สวัสดี ทดสอบ");
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("reading the audit log itself writes an instance_audit row (R25: audited on read too)", async () => {
    const s = await scratch();
    try {
      const out = await runScript(
        s.dataDir,
        s.policyPath,
        `
        const { openInstanceAuditTable } = await import("${join(SRC, "audit", "instanceAudit.openInstanceAuditTable.ts")}");
        await service.readInstanceAudit("Bearer ${TOKENS.backfillOnly.secret}", {});
        const table = await openInstanceAuditTable();
        const rows = await table.query().toArray();
        console.log(JSON.stringify({ rows: rows.map((r) => ({ route: r.route, action: r.action, outcome: r.outcome })) }));
        `,
      );
      expect(out.rows).toEqual([{ route: "/api/instance-audit", action: "instance-audit:read", outcome: "admitted" }]);
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("HTTP order: bank 400 before policy; admission before parameter validation; every attempt audited", async () => {
    const s = await scratch();
    try {
      const out = await runScript(
        s.dataDir,
        s.policyPath,
        `
        const { Elysia } = await import("elysia");
        const { instanceAuditRoute } = await import("${join(SRC, "app.instanceAuditRoute.ts")}");
        const { openInstanceAuditTable } = await import("${join(SRC, "audit", "instanceAudit.openInstanceAuditTable.ts")}");
        const app = new Elysia().use(instanceAuditRoute(service, () => null));
        const call = async (query, token) => {
          const headers = token ? { authorization: "Bearer " + token } : {};
          return (await app.handle(new Request("http://127.0.0.1/api/instance-audit" + query, { headers }))).status;
        };
        const status = {
          anonBank: await call("?bank=alpha", null),
          opBank: await call("?bank=alpha", "${TOKENS.backfillOnly.secret}"),
          anonBadLimit: await call("?limit=0", null),
          wsBadLimit: await call("?limit=0", "${TOKENS.workspace.secret}"),
          wsBadRoute: await call("?route=/x", "${TOKENS.workspace.secret}"),
          opBadLimit: await call("?limit=0", "${TOKENS.backfillOnly.secret}"),
          opBadRoute: await call("?route=/x", "${TOKENS.backfillOnly.secret}"),
          opBadOutcome: await call("?outcome=maybe", "${TOKENS.backfillOnly.secret}"),
          opOk: await call("", "${TOKENS.backfillOnly.secret}"),
        };
        const table = await openInstanceAuditTable();
        const rows = (await table.query().toArray()).filter((r) => r.route === "/api/instance-audit");
        const tally = (outcome, st) => rows.filter((r) => r.outcome === outcome && r.status === st).length;
        console.log(JSON.stringify({ status, total: rows.length, refused: tally("refused", "error"), admittedError: tally("admitted", "error"), admittedOk: tally("admitted", "ok") }));
        `,
      );
      expect(out.status).toEqual({
        anonBank: 400, opBank: 400,
        anonBadLimit: 401, wsBadLimit: 403, wsBadRoute: 403,
        opBadLimit: 400, opBadRoute: 400, opBadOutcome: 400,
        opOk: 200,
      });
      // bank 400s never reach policy, so they write nothing. The 3 unadmitted
      // attempts are refused rows; the 3 bad-parameter reads by the operator
      // are admitted errors; the good read is admitted ok.
      expect({ total: out.total, refused: out.refused, admittedError: out.admittedError, admittedOk: out.admittedOk })
        .toEqual({ total: 7, refused: 3, admittedError: 3, admittedOk: 1 });
    } finally {
      await s.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
