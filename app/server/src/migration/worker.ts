/**
 * #34 copy-migration knowledge worker (rulings R11 + R17). OPERATOR-ONLY.
 *
 *   python -m arra_migrate.copy_migration  (holds writer_gate(candidate))
 *     -> adopt_gate: the SAME held descriptor becomes fd 42
 *       -> bun run src/migration/worker.ts <plan.json>
 *
 * Not imported by any route, MCP tool or `app/cli.ts`, and not reachable from
 * the composition root. It opens the evidence writer bundle on the candidate
 * (the kernel re-verifies fd 42 and the 19-table shape before connecting),
 * publishes every planned memory, derives projections, writes lifecycle
 * events, reads every head back, runs every stored-row codec, and prints one
 * JSON line per outcome on stdout. Governed refusals are lines; anything else
 * is a fault: exit 1, and the orchestrator discards the candidate.
 */

import { readFileSync } from "node:fs";
import { openEvidenceWriter } from "../publication/service.openEvidenceWriter";
import { checkStoredRows } from "./checkStoredRows";
import { migrateWorkspace } from "./migrateWorkspace";
import { type Emit, type MigrationPlan, type WorkerControls } from "./plan.types";
import { readBackNodes } from "./readBackNodes";

export async function runMigrationWorker(planPath: string, env: NodeJS.ProcessEnv, emit: Emit): Promise<void> {
  const plan = JSON.parse(readFileSync(planPath, "utf-8")) as MigrationPlan;
  if (plan.version !== "arra-migrate-copy/plan-v1") throw new Error(`unsupported plan version ${String(plan.version)}`);

  const controls: WorkerControls = { now: plan.intake_at_ms, nextRevisionId: null };
  const bundle = await openEvidenceWriter(plan.candidate_root, {
    clock: () => controls.now,
    newRevisionId: () => {
      const id = controls.nextRevisionId;
      if (id === null) throw new Error("revision id requested outside a planned publish");
      controls.nextRevisionId = null;
      return id;
    },
    // Local-only intake: migrated messages are source-less legacy rows.
    sourceNamespace: null,
    env,
  });
  const published = new Set<string>();
  try {
    for (const workspace of plan.workspaces) {
      await migrateWorkspace(bundle, controls, plan.intake_at_ms, workspace, published, emit);
    }
    await readBackNodes(bundle, plan, published, emit);
  } finally {
    await bundle.close();
  }
  await checkStoredRows(plan.candidate_root, emit);
  emit({ kind: "done" });
}

if (import.meta.main) {
  const planPath = process.argv[2];
  if (!planPath) {
    console.error("usage: bun run src/migration/worker.ts <plan.json>");
    process.exit(2);
  }
  const lines: string[] = [];
  try {
    await runMigrationWorker(planPath, process.env, (line) => lines.push(JSON.stringify(line)));
    await Bun.write(Bun.stdout, lines.join("\n") + "\n");
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
}
