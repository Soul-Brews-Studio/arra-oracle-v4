// #31 "audit consistently across all transports", the global maintenance
// routes (maint-audit slice, 2026-09-27), live on a REAL listening server over
// a fresh dataset (`fixtures/transport-v1/live-server/child.ts`).
//
// `POST /api/backfill` and `POST /api/reindex` admit a GLOBAL action
// (`maintenance:backfill`, `maintenance:reindex`). They write no `mcp_calls`
// row and no `connections` fold, on success or on an admitted failure. That is
// a deviation from R5 ("written on every request"), OPEN for a human, and it is
// pinned here rather than changed because every way to close it needs a
// decision this slice cannot make:
//   - the frozen contract (`authorization-integration-v1.md` §4) lets "only
//     tool calls admitted for their exact action ... append scoped rows" and
//     forbids a physical schema change for this integration;
//   - SPEC §6.3 makes `mcp_calls.workspace_name` NOT NULL and a key into
//     `workspaces` ("THE tenant column"), and §7.2 gives `connections` the
//     same column. A global action has no workspace, so the only way to write
//     its row is a sentinel name, which the target copy
//     (`copy_migration/activity_tables.py`) would drop as
//     `workspace_unresolved` and no scoped reader could ever return.
// The amendment "#31 TODO 'audit consistently across all transports' + R5/R19"
// keeps the round-4 "Open for a human" note and lists the options; a ruling
// lands in DECISIONS.md, and `transport-audit-maintenance-open.test.ts` makes
// this test, that note and the `app.ts` comment move with it.
//
// Why a direct table read: every wire reader is scoped to one admitted
// workspace, so a row filed under a sentinel name is invisible over HTTP and
// MCP. The child's `tables` step reads both tables unscoped, which is the only
// view that proves no maintenance row exists anywhere. One admitted MCP call is
// the positive control: the same read must see ITS row and ITS fold.

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

type TableRow = { workspace_name: unknown; tool: unknown; status: unknown };

runIt(
  "admitted maintenance calls, ok or failed, write no mcp_calls row and no connections fold in any workspace",
  async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    cleanups.push(fixture.cleanup);
    const workDir = await mkdtemp(join(tmpdir(), "arra-v4-audit-maint-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));

    const legacy = (label: string, token: string, path: string, body?: unknown) =>
      ({ label, transport: "legacy", token, bank: "alpha", method: "", httpMethod: "POST", path, body });
    const steps = [
      // ── admitted global maintenance: success and an admitted failure ─
      legacy("maint_backfill", "maint", "/api/backfill", {}),
      legacy("maint_backfill_bad", "maint", "/api/backfill?batch=0", {}),
      legacy("maint_reindex", "maint", "/api/reindex", {}),
      // ── refused before admission ─────────────────────────────────────
      legacy("write_backfill", "write", "/api/backfill", {}),
      legacy("none_reindex", "none", "/api/reindex", {}),
      // ── positive control: one admitted, workspace-scoped MCP call ────
      { label: "control", transport: "mcp", token: "write", bank: "alpha", method: "list_memories", body: { limit: 5 } },
      { label: "settle", transport: "settle", token: "audit", bank: "alpha", method: "", ms: scaledMs(15_000), folds: 1 },
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

    // ── the responses: unchanged ──────────────────────────────────────────
    expect(out.maint_backfill.status, show("maint_backfill")).toBe(200);
    expect(out.maint_backfill_bad, show("maint_backfill_bad")).toEqual({ status: 400, body: { error: "bad request" } });
    expect(out.maint_reindex.status, show("maint_reindex")).toBe(200);
    expect(out.write_backfill.status, show("write_backfill")).toBe(403);
    expect(out.none_reindex.status, show("none_reindex")).toBe(401);
    expect(out.control.isError, show("control")).toBe(false);

    // ── the operations tables, unscoped: only the control's row and fold ─
    expect(out.settle.requests, show("settle")).toBe(1);
    const calls = out.tables.mcp_calls as TableRow[];
    const conns = out.tables.connections as TableRow[];
    expect(calls, show("tables")).toEqual([{ workspace_name: ALPHA, tool: "list_memories", status: "ok" }]);
    expect(conns, show("tables")).toEqual([{ workspace_name: ALPHA, tool: "list_memories", status: null }]);
    // No row anywhere names a maintenance action or a workspace that does not exist.
    for (const row of [...calls, ...conns]) {
      expect([ALPHA, BETA]).toContain(String(row.workspace_name));
      expect(String(row.tool)).not.toMatch(/backfill|reindex|maintenance/);
    }
  },
  TEST_TIMEOUT_MS,
);
