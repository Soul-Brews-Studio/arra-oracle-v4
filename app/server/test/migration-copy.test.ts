/**
 * #34 copy-migration rehearsal, end to end over the REAL server (R11 + R17).
 *
 *   legacy-15 source (Python fixture, mktemp)
 *     |-- live server #1, ARRA_DATA_DIR=source ...... legacy MCP recall = golden
 *     |-- arra_migrate.copy_migration (operator CLI)  source sha256 tree unchanged
 *     |      Python direct tables + Bun knowledge worker, inside writer_gate(candidate)
 *     `-- live server #2, source + candidate ......... recall == golden (rollback)
 *                                                      kb listNodes/getAcceptedHead
 *                                                      read the migrated nodes
 *
 * Rollback here means: the source was never replaced, so pointing the service
 * back at it (or simply never unmounting it) serves exactly the prior answers.
 * No production cutover is rehearsed or implied.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@lancedb/lancedb";

import { assertTargetDataset, TARGET_TABLES } from "../src/publication/storage";
import {
  buildLegacySource,
  hashTree,
  runCopyMigration,
  startServer,
  writeReadPolicy,
} from "./helpers/migration-fixture";

const LAB = "oracle-lab";
const SIDE = "side-bank";
const INTAKE_AT = "2026-09-26T14:00:00.000Z";
const QUERIES = ["LanceDB", "กุญแจ", "conclusion"];

let parent: string;
let source: string;
let candidate: string;
let work: string;
let policy: string;
let golden: Record<string, string[]>;
let before: Record<string, string>;
let after: Record<string, string>;
let migration: Awaited<ReturnType<typeof runCopyMigration>>;

const recallIds = async (server: Awaited<ReturnType<typeof startServer>>) => {
  const out: Record<string, string[]> = {};
  for (const query of QUERIES) {
    const rows = (await server.mcp(LAB, "recall", { query, limit: 50 })) as Array<{ id: string }>;
    out[query] = rows.map((row) => row.id).sort();
  }
  return out;
};

beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), "arra-migration-copy-"));
  source = join(parent, "source");
  candidate = join(parent, "candidate");
  work = join(parent, "work");
  policy = join(parent, "policy.json");
  await mkdir(candidate);
  await buildLegacySource(source);
  await writeReadPolicy(policy, [LAB, SIDE]);

  // 1. The legacy service, before any migration: the golden answers.
  const legacy = await startServer({ dataDir: source, policyPath: policy });
  try {
    golden = await recallIds(legacy);
  } finally {
    await legacy.stop();
  }

  // 2. The migration, bracketed by an independent hash of the ORIGINAL source.
  before = hashTree(source);
  migration = await runCopyMigration({ source, candidate, work, intakeAt: INTAKE_AT });
  after = hashTree(source);
}, 240_000);

afterAll(async () => {
  if (parent) await rm(parent, { recursive: true, force: true });
});

describe("copy migration: source and report", () => {
  test("the operator CLI exits 0 and writes a report", () => {
    expect(migration.stderr).not.toContain("Traceback");
    expect(migration.code).toBe(0);
    expect(migration.report).not.toBeNull();
  });

  test("the original source tree is byte-identical across the migration", () => {
    expect(Object.keys(before).length).toBeGreaterThan(0);
    expect(after).toEqual(before);
    expect(migration.report!.source.untouched).toBe(true);
  });

  test("conservation holds for every source table, memories and memory_terms included", () => {
    const tables = migration.report!.tables as Record<string, Record<string, number>>;
    expect(Object.keys(tables).sort()).toContain("memories");
    expect(Object.keys(tables).sort()).toContain("memory_terms");
    expect(Object.keys(tables)).toHaveLength(15);
    for (const [name, t] of Object.entries(tables)) {
      expect({ name, sum: t.migrated! + t.rejected! + t.unresolved! }).toEqual({ name, sum: t.rows_in! });
    }
    expect(migration.report!.conservation_ok).toBe(true);
  });

  test("the report names #7, #8 and #10 as release-excluded and is not release-ready", () => {
    const issues = (migration.report!.release_exclusions as Array<{ issue: number }>).map((e) => e.issue).sort((a, b) => a - b);
    expect(issues).toEqual([7, 8, 10]);
    expect(migration.report!.release_ready).toBe(false);
  });
});

describe("copy migration: operator-only", () => {
  test("no server module and not app/cli.ts imports the migration worker", () => {
    const root = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (path !== join(root, "migration")) walk(path);
        } else if (/\.tsx?$/.test(entry.name) && /from\s+["'][^"']*\/migration\//.test(readFileSync(path, "utf-8"))) {
          offenders.push(path);
        }
      }
    };
    walk(root);
    const cli = readFileSync(join(import.meta.dir, "..", "..", "cli.ts"), "utf-8");
    if (/migration\//.test(cli) || /copy_migration|arra-migrate-copy/.test(cli)) offenders.push("app/cli.ts");
    expect(offenders).toEqual([]);
  });
});

describe("copy migration: the candidate is target-19 and the TS kernel reads it", () => {
  test("assertTargetDataset accepts the candidate and it holds exactly the 19 tables", async () => {
    const connection = await connect(candidate);
    await assertTargetDataset(connection);
    expect((await connection.tableNames({ limit: 1000 })).sort()).toEqual([...TARGET_TABLES].sort());
  });

  test("a live server reads the migrated nodes over HTTP, and legacy recall is unchanged", async () => {
    const server = await startServer({ dataDir: source, policyPath: policy, knowledgeRoot: candidate });
    try {
      // Compatibility / rollback: the legacy MCP recall path on the untouched
      // source still answers exactly what it answered before the migration.
      expect(await recallIds(server)).toEqual(golden);
      expect(golden.LanceDB).toContain("m_muigr1bb_retro");

      const listed = await server.knowledge(LAB, "listNodes", {
        workspace_name: LAB, after_id: null, limit: 100, include_total: true, type_term: null,
      });
      expect(listed.status).toBe(200);
      const rows = listed.body.rows as Array<Record<string, any>>;
      expect(rows.length).toBeGreaterThanOrEqual(3);

      const bodies: string[] = [];
      for (const row of rows) {
        const nodeId = (row.node_id ?? row.id) as string;
        const head = await server.knowledge(LAB, "getAcceptedHead", { workspace_name: LAB, node_id: nodeId });
        expect(head.status).toBe(200);
        bodies.push(JSON.stringify(head.body));
      }
      expect(bodies.some((b) => b.includes("ลืมกุญแจไว้ที่บ้าน"))).toBe(true);
      expect(bodies.some((b) => b.includes("Keys live on the hook by the door now."))).toBe(true);

      // Workspace isolation holds on migrated data: side-bank sees only its own.
      const side = await server.knowledge(SIDE, "listNodes", {
        workspace_name: SIDE, after_id: null, limit: 100, include_total: true, type_term: null,
      });
      expect(side.status).toBe(200);
      expect(JSON.stringify(side.body)).not.toContain("ลืมกุญแจ");
    } finally {
      await server.stop();
    }
  }, 120_000);
});
