// #31 maint-audit (Nat 2026-09-28 D4b): the separate instance-level audit log
// for `POST /api/backfill` and `POST /api/reindex`. Companion to
// `transport-audit-maintenance.test.ts`, which pins that `mcp_calls` and
// `connections` still get no maintenance row anywhere (unchanged by this
// slice). This file pins the NEW behaviour: one `instance_audit` row per
// admitted call and per refused call, redacted, on a real listening server
// over a fresh dataset (`fixtures/transport-v1/live-server/child.ts`,
// extended with `instance_audit` in its `tables` step).

import { afterAll, describe, expect, test } from "bun:test";
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

runIt(
  "an admitted call, an admitted failure and a refusal each write exactly one instance_audit row, never a mcp_calls/connections row",
  async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    cleanups.push(fixture.cleanup);
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-audit-instance-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const legacy = (label: string, token: string, path: string, body?: unknown) =>
      ({ label, transport: "legacy", token, bank: "alpha", method: "", httpMethod: "POST", path, body });
    const steps = [
      legacy("maint_backfill", "maint", "/api/backfill", {}),
      legacy("maint_backfill_bad", "maint", "/api/backfill?batch=0", {}),
      legacy("maint_reindex", "maint", "/api/reindex", {}),
      legacy("write_backfill", "write", "/api/backfill", {}),
      legacy("none_reindex", "none", "/api/reindex", {}),
      { label: "tables", transport: "tables", token: "audit", bank: "alpha", method: "" },
    ];
    const result = await runGated(fixture.datasetRoot, CHILD, [
      fixture.datasetRoot,
      workDir,
      JSON.stringify({ banks: { alpha: ALPHA, beta: BETA }, steps }),
    ]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(-2000)}`);
    const out: Record<string, any> = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    const show = (label: string) => `${label}: ${JSON.stringify(out[label])}`;

    expect(out.maint_backfill.status, show("maint_backfill")).toBe(200);
    expect(out.maint_backfill_bad, show("maint_backfill_bad")).toEqual({ status: 400, body: { error: "bad request" } });
    expect(out.maint_reindex.status, show("maint_reindex")).toBe(200);
    expect(out.write_backfill.status, show("write_backfill")).toBe(403);
    expect(out.none_reindex.status, show("none_reindex")).toBe(401);

    const rows = out.tables.instance_audit as Array<Record<string, unknown>>;
    expect(rows.length, show("tables")).toBe(5);

    const byRoute = (route: string, action: string) => rows.filter((r) => r.route === route && r.action === action);
    const backfillRows = byRoute("/api/backfill", "maintenance:backfill");
    const reindexRows = byRoute("/api/reindex", "maintenance:reindex");
    expect(backfillRows.length, show("tables")).toBe(3); // ok, bad-batch (admitted+failed), refused
    expect(reindexRows.length, show("tables")).toBe(2); // ok, refused

    const admitted = rows.filter((r) => r.outcome === "admitted");
    const refused = rows.filter((r) => r.outcome === "refused");
    expect(admitted.length, show("tables")).toBe(3);
    expect(refused.length, show("tables")).toBe(2);
    for (const r of refused) expect(r.principal_id, show("tables")).toBeNull();
    for (const r of admitted) expect(r.principal_id, show("tables")).not.toBeNull();

    const failedAdmit = admitted.find((r) => r.route === "/api/backfill" && r.status === "error");
    expect(failedAdmit, show("tables")).toBeTruthy();

    // Never in the tenant tables, under any name.
    for (const table of [out.tables.mcp_calls, out.tables.connections] as Array<Array<{ tool: unknown }>>) {
      for (const row of table) expect(String(row.tool)).not.toMatch(/backfill|reindex|maintenance/);
    }
  },
  TEST_TIMEOUT_MS,
);

runIt(
  "fix-round 2: a REFUSED call first on a fresh instance still writes its row " +
    "(schema must not be inferred from a null-`principal_id` sample)",
  async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    cleanups.push(fixture.cleanup);
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-audit-instance-refusal-first-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const legacy = (label: string, token: string, path: string, body?: unknown) =>
      ({ label, transport: "legacy", token, bank: "alpha", method: "", httpMethod: "POST", path, body });
    // Refusals FIRST, on an instance that has never written an instance_audit
    // row: the exact ordering the live probe uses, and the ordering the
    // verifier reproduced the schema-inference crash with.
    const steps = [
      legacy("none_reindex_first", "none", "/api/reindex", {}),
      legacy("write_backfill_first", "write", "/api/backfill", {}),
      legacy("maint_backfill", "maint", "/api/backfill", {}),
      { label: "tables", transport: "tables", token: "audit", bank: "alpha", method: "" },
    ];
    const result = await runGated(fixture.datasetRoot, CHILD, [
      fixture.datasetRoot,
      workDir,
      JSON.stringify({ banks: { alpha: ALPHA, beta: BETA }, steps }),
    ]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(-2000)}`);
    const out: Record<string, any> = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    const show = (label: string) => `${label}: ${JSON.stringify(out[label])}`;

    expect(out.none_reindex_first.status, show("none_reindex_first")).toBe(401);
    expect(out.write_backfill_first.status, show("write_backfill_first")).toBe(403);
    expect(out.maint_backfill.status, show("maint_backfill")).toBe(200);

    const rows = out.tables.instance_audit as Array<Record<string, unknown>>;
    // Both refusals AND the later admitted call must all land -- the bug
    // this pins dropped every refusal until an admitted call created the
    // table, so a naive fix that only "worked" because the first call
    // happened to be admitted would still fail this ordering.
    expect(rows.length, show("tables")).toBe(3);
    const refused = rows.filter((r) => r.outcome === "refused");
    expect(refused.length, show("tables")).toBe(2);
    for (const r of refused) expect(r.principal_id, show("tables")).toBeNull();
  },
  TEST_TIMEOUT_MS,
);

describe("instance audit write failure (isolated subprocess: defines the D4b behaviour)", () => {
  // #31 fix-round 2: the amendment claimed a forced-write-failure test
  // existed; it did not (`rg instanceAuditFailureCount` found only the
  // getter's own definition). This is that test. It runs in a SEPARATE
  // process, deliberately: `storage.ts`'s `DATA_DIR` is read once at
  // module-import time (see the redaction test's own comment above), so the
  // only way to force `openInstanceAuditTable`'s `connect()` to throw is to
  // point `ARRA_DATA_DIR` at a path that cannot be a Lance dataset root
  // (a plain FILE, not a directory) BEFORE that module is ever imported.
  test("a forced instance_audit write failure does not throw into the caller, and increments the observable counter", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-audit-instance-failure-"));
    const notADir = join(workDir, "not-a-directory");
    await Bun.write(notADir, "not a lance dataset root");
    try {
      const script = `
        const { appendInstanceAuditRow } = await import("${join(import.meta.dir, "..", "src", "audit", "instanceAudit.appendInstanceAuditRow.ts")}");
        const { instanceAuditFailureCount } = await import("${join(import.meta.dir, "..", "src", "audit", "instanceAudit.instanceAuditFailureCount.ts")}");
        const before = instanceAuditFailureCount();
        let threw = false;
        try {
          await appendInstanceAuditRow({
            principal_id: null, route: "/api/reindex", action: "maintenance:reindex",
            outcome: "refused", status: "error", input: {}, started_at: 1, finished_at: 2, request_id: "req_x",
          });
        } catch { threw = true; }
        console.log(JSON.stringify({ threw, before, after: instanceAuditFailureCount() }));
      `;
      const proc = Bun.spawn(["bun", "-e", script], {
        env: { ...process.env, ARRA_DATA_DIR: notADir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(`subprocess exited ${code}: ${stderr.slice(-2000)}`);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      // The defined behaviour (D4b, "a failed write does not silently
      // succeed"): the route is never taken down by an audit outage (no
      // throw), but the failure is OBSERVABLE (the counter moves), never
      // dropped without a trace.
      expect(result.threw, stdout).toBe(false);
      expect(result.after, stdout).toBe(result.before + 1);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

describe("instance audit redaction (pure, no storage touched)", () => {
  // Deliberately does NOT call `appendInstanceAuditRow` in-process:
  // `storage.ts`'s `DATA_DIR` is read once at module import, so an in-process
  // call cannot be pointed at a scratch directory, and calling it for real
  // here would write to whatever `ARRA_DATA_DIR` this test process happens to
  // default to -- exactly the `app/data` leak this slice found and fixed
  // (`logInstanceAudit` is now injected, `service.types.ts` has the story).
  // The live-server test above is what exercises the real write path,
  // including the redacted `input_summary` column, end to end in a scratch
  // dataset. This only pins that `appendInstanceAuditRow` reuses the SAME
  // `truncate`/`redact` the tenant audit uses (R5), not a re-derived copy.
  test("truncate() redacts a secret the same way the tenant audit does", async () => {
    // A DYNAMIC import, deliberately, and inside the test body, not at module
    // top level: `mcp/calls.ts` statically imports `calls.openCallLogTable.ts`,
    // which statically imports `storage.ts`. Even a top-level `await import`
    // still runs during the module-LOAD phase (before any file's `beforeAll`),
    // and resolves `storage.ts`'s `DATA_DIR` (read once, process-wide) before
    // another test file's `beforeAll` sets its own scratch `ARRA_DATA_DIR` --
    // exactly the `app/data` leak this slice found (twice) and fixed.
    const { truncate } = await import("../src/mcp/calls");
    const secret = "Bearer some-long-token-value";
    const out = truncate({ authorization: secret, nested: { api_key: "key-123", safe: "kept" } });
    expect(out).not.toContain("key-123");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("kept");
  });
});
