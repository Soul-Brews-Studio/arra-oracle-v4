/**
 * #34 copy-migration rehearsal, end to end over the REAL server (R11 + R17).
 *
 *   legacy-15 source (Python fixture, mktemp)
 *     |-- live server #1, ARRA_DATA_DIR=source ...... legacy MCP answers = golden
 *     |-- arra_migrate.copy_migration (operator CLI)  source sha256 tree unchanged
 *     |      Python direct tables + Bun knowledge worker, inside writer_gate(candidate)
 *     |-- live server #2, source + candidate ......... legacy answers == golden
 *     |                                                kb listNodes/getAcceptedHead
 *     |                                                read the migrated nodes
 *     |-- gated taxonomy child on the candidate ...... the kernel accepts the
 *     |                                                migrated flat taxonomy
 *     |-- gated reconcile child on a COPY ............ emptied projections
 *     |                                                rebuild to identical rows
 *     `-- live server #3, source ALONE again ......... legacy answers == golden
 *                                                      (the rollback restart)
 *
 * "Legacy answers" are the FULL MCP responses of recall, get_memory and
 * list_memories, compared as JSON -- not id sets. Rollback means: the source
 * was never replaced, so restarting the service on it alone, after the
 * candidate was mounted, serves exactly the prior answers. No production
 * cutover is rehearsed or implied.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync } from "node:fs";
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
import { runGated } from "./helpers/publication-fixture";

const LAB = "oracle-lab";
const SIDE = "side-bank";
const INTAKE_AT = "2026-09-26T14:00:00.000Z";
const QUERIES = ["LanceDB", "กุญแจ", "conclusion"];
const TAXONOMY_CHILD = new URL("./fixtures/taxonomy-v1/core/gated-taxonomy.ts", import.meta.url).pathname;
const RECONCILE_CHILD = new URL("./fixtures/migration/reconcile-child.ts", import.meta.url).pathname;
const DERIVED = ["node_revision_terms", "revision_links"] as const;

/** Every row of a table as sorted JSON text (Int64 as decimal text). */
const tableText = async (root: string, name: string): Promise<string[]> => {
  const connection = await connect(root);
  const rows = await (await connection.openTable(name)).query().toArray();
  connection.close();
  return rows
    .map((row) => JSON.stringify(row, (_, v) => (typeof v === "bigint" ? v.toString(10) : v)))
    .sort();
};

/** R18 D1, written out independently of the implementation. */
const legacyNodeId = (ws: string, legacyId: string) =>
  createHash("sha256").update(`arra-legacy-node/v1\n${ws}\n${legacyId}`).digest("base64url").slice(0, 21);

let parent: string;
let source: string;
let candidate: string;
let work: string;
let policy: string;
let golden: Record<string, string>;
let before: Record<string, string>;
let after: Record<string, string>;
let migration: Awaited<ReturnType<typeof runCopyMigration>>;

/** The legacy service's FULL answers, as JSON text: recall, get_memory, list_memories. */
const legacyAnswers = async (server: Awaited<ReturnType<typeof startServer>>) => {
  const out: Record<string, string> = {};
  for (const query of QUERIES) {
    out[`recall:${query}`] = JSON.stringify(await server.mcp(LAB, "recall", { query, limit: 50 }));
  }
  for (const id of ["m_muigr1bb_retro", "m_muigqmxf_qchtyc"]) {
    out[`get_memory:${id}`] = JSON.stringify(await server.mcp(LAB, "get_memory", { id }));
  }
  out.list_memories = JSON.stringify(await server.mcp(LAB, "list_memories", { limit: 100 }));
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
    golden = await legacyAnswers(legacy);
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
      // Compatibility: with the candidate mounted beside it, the legacy MCP
      // path on the untouched source answers exactly what it answered before.
      expect(await legacyAnswers(server)).toEqual(golden);
      expect(golden["recall:LanceDB"]).toContain("m_muigr1bb_retro");

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
      expect(bodies.some((b) => b.includes("Keys live on the hook by the door now."))).toBe(true);

      // The Thai memory was SUPERSEDED, so a listNodes default that hides
      // terminal nodes (#29, R18 D3) may not enumerate it. Read it by its
      // R18 D1 id instead: the v3-compat resolver's exact path.
      const thai = await server.knowledge(LAB, "getAcceptedHead", {
        workspace_name: LAB, node_id: legacyNodeId(LAB, "m_muigqmxf_qchtyc"),
      });
      expect(thai.status).toBe(200);
      expect(JSON.stringify(thai.body)).toContain("ลืมกุญแจไว้ที่บ้าน");

      // R11: a type too long to be a tag term still migrates as `note`, and
      // the kernel reads it like any other node.
      const stuffed = await server.knowledge(LAB, "getAcceptedHead", {
        workspace_name: LAB, node_id: legacyNodeId(LAB, "m_muigr6gg_longtype"),
      });
      expect(stuffed.status).toBe(200);
      expect(JSON.stringify(stuffed.body)).toContain("a type field someone filled with prose");

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

  test("the kernel accepts the migrated flat taxonomy: a dropped legacy parent is not corruption", async () => {
    // Before the fix the legacy parent was stored in a flat vocabulary, and
    // the kernel's own reparentTerm read that as integrity_failure.
    const connection = await connect(candidate);
    const terms = await (await connection.openTable("terms")).query().toArray();
    connection.close();
    const keys = terms.find((t) => t.name === "keys" && t.workspace_name === LAB);
    const retro = terms.find((t) => t.name === "retro" && t.workspace_name === LAB);
    expect(keys).toBeDefined();
    expect(retro).toBeDefined();
    const detach = (term: Record<string, unknown>) => ({
      method: "reparentTerm",
      request: { workspace_name: LAB, term_id: term.id, expected_parent_id: null, parent_id: null },
    });
    const result = await runGated(candidate, TAXONOMY_CHILD, [
      candidate,
      JSON.stringify({ ops: [detach(keys!), detach(retro!)], clockMs: Date.parse(INTAKE_AT) }),
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);
    expect(parsed.op0).toEqual({ ok: true, value: expect.objectContaining({ outcome: "already_satisfied" }) });
    expect(parsed.op1).toEqual({ ok: true, value: expect.objectContaining({ outcome: "already_satisfied" }) });
  }, 120_000);

  test("projections rebuild to the same meaning: emptied derived tables reconcile back to identical rows", async () => {
    // Revision snapshots are authoritative; node_revision_terms and
    // revision_links are rebuildable projections of them (#34 association gate).
    const rebuilt = join(parent, "rebuilt");
    cpSync(candidate, rebuilt, { recursive: true, filter: (path) => !path.endsWith(".arra-writer.lock") });
    const connection = await connect(rebuilt);
    for (const name of DERIVED) {
      const table = await connection.openTable(name);
      await table.delete("true");
      expect(await table.countRows()).toBe(0);
    }
    connection.close();

    const result = await runGated(rebuilt, RECONCILE_CHILD, [rebuilt]);
    expect(result.code).toBe(0);
    const { outcomes } = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)!);
    const values = Object.values(outcomes) as Array<{ outcome: string }>;
    // 11 legacy memories, one rejected for a sub-millisecond clock.
    expect(values).toHaveLength(10);
    expect(values.every((o) => o.outcome === "reconciled")).toBe(true);
    for (const name of DERIVED) {
      const original = await tableText(candidate, name);
      expect(original.length).toBeGreaterThan(0);
      expect(await tableText(rebuilt, name)).toEqual(original);
    }
  }, 120_000);
});

describe("copy migration: rollback", () => {
  test("restarted on the source ALONE after the candidate was mounted, the legacy answers are unchanged", async () => {
    const server = await startServer({ dataDir: source, policyPath: policy });
    try {
      expect(await legacyAnswers(server)).toEqual(golden);
    } finally {
      await server.stop();
    }
    expect(migration.report!.cutover).toContain("none");
  }, 120_000);
});
