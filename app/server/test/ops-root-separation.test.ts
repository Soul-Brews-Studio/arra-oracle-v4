// R33 S4(a) (Nat 2026-09-28, docs/overnight/DECISIONS.md): the operations
// tables `mcp_calls`, `connections` and `instance_audit` move to a sibling
// Lance root, `ARRA_OPS_DIR`, when set -- default (unset) keeps them at
// `ARRA_DATA_DIR` exactly as before.
//
// Each scenario runs in its own subprocess (Bun.spawn) because
// `storage.ts`'s `DATA_DIR`/`OPS_DIR` are module-level singletons read once
// at import time (same reason every other ops-root test in this suite
// spawns rather than importing in-process -- see
// `instance-audit-reader.test.ts`'s header).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTimeout } from "./helpers/timing.testTimeout";

const TEST_TIMEOUT_MS = testTimeout(60_000);
const SRC = join(import.meta.dir, "..", "src");
const MIGRATE_DIR = join(import.meta.dir, "..", "..", "migrate-py");
const PYTHON = process.env.ARRA_CONTRACT_PYTHON ?? join(MIGRATE_DIR, ".venv", "bin", "python");

/** `openCallLogTable`/`openConnectionsTable` assume the table already exists
 *  (a real deployment always runs the migrator first) -- create it with the
 *  same `--ops`/`--legacy-active15` entry points the migrator ships. */
async function migrate(root: string, envVar: "ARRA_DATA_DIR" | "ARRA_OPS_DIR", flag: string): Promise<void> {
  const proc = Bun.spawn([PYTHON, "-m", "arra_migrate", flag], {
    cwd: MIGRATE_DIR,
    env: { ...process.env, [envVar]: root, PYTHONPATH: join(MIGRATE_DIR, "src") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`arra_migrate ${flag} exited ${code}: ${stderr.slice(-2000)}`);
}

async function runScript(env: Record<string, string>, body: string): Promise<any> {
  const script = `
    const { logCall } = await import("${join(SRC, "mcp", "calls.logCall.ts")}");
    const { foldConnection } = await import("${join(SRC, "mcp", "connections.foldConnection.ts")}");
    const { appendInstanceAuditRow } = await import("${join(SRC, "audit", "instanceAudit.appendInstanceAuditRow.ts")}");
    ${body}
  `;
  const proc = Bun.spawn(["bun", "-e", script], {
    env: { ...process.env, ...env },
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

async function scratch(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("ARRA_OPS_DIR (R33 S4(a))", () => {
  test(
    "when set, mcp_calls/connections/instance_audit write ONLY under the ops root, never the legacy root",
    async () => {
      const data = await scratch("arra-v4-ops-data-");
      const ops = await scratch("arra-v4-ops-ops-");
      try {
        await migrate(ops.dir, "ARRA_OPS_DIR", "--ops");
        const out = await runScript(
          { ARRA_DATA_DIR: data.dir, ARRA_OPS_DIR: ops.dir },
          `
            await logCall({ tool: "arra_remember", input: {}, status: "ok", result: {}, duration_ms: 1, workspace_name: "alpha" });
            await foldConnection({ workspace_name: "alpha", method: "http", principal: "p1", label: "l1" });
            await appendInstanceAuditRow({
              principal_id: "p1", route: "/api/backfill", action: "maintenance:backfill",
              outcome: "admitted", status: "ok", input: {}, started_at: Date.now(),
              finished_at: Date.now(), request_id: "r1",
            });
            console.log(JSON.stringify({ done: true }));
          `,
        );
        expect(out.done).toBe(true);
        for (const table of ["mcp_calls.lance", "connections.lance", "instance_audit.lance"]) {
          expect(existsSync(join(ops.dir, table))).toBe(true);
          expect(existsSync(join(data.dir, table))).toBe(false);
        }
      } finally {
        await data.cleanup();
        await ops.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "when ARRA_OPS_DIR is unset, ops tables keep writing to ARRA_DATA_DIR (unchanged default)",
    async () => {
      const data = await scratch("arra-v4-ops-default-");
      try {
        await migrate(data.dir, "ARRA_DATA_DIR", "--legacy-active15");
        const out = await runScript(
          { ARRA_DATA_DIR: data.dir },
          `
            await logCall({ tool: "arra_remember", input: {}, status: "ok", result: {}, duration_ms: 1, workspace_name: "alpha" });
            await foldConnection({ workspace_name: "alpha", method: "http", principal: "p1", label: "l1" });
            await appendInstanceAuditRow({
              principal_id: "p1", route: "/api/backfill", action: "maintenance:backfill",
              outcome: "admitted", status: "ok", input: {}, started_at: Date.now(),
              finished_at: Date.now(), request_id: "r1",
            });
            console.log(JSON.stringify({ done: true }));
          `,
        );
        expect(out.done).toBe(true);
        for (const table of ["mcp_calls.lance", "connections.lance", "instance_audit.lance"]) {
          expect(existsSync(join(data.dir, table))).toBe(true);
        }
      } finally {
        await data.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
