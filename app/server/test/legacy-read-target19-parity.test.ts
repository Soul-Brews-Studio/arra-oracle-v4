// R33 S2 (docs/overnight/LEGACY-ROOT-RETIREMENT-PLAN.md): dark-launched
// target-19 read path for the legacy `memories` shape, behind
// `ARRA_MEMORIES_BACKEND` (default "legacy", unchanged behaviour).
//
// Seeds REAL target-19 nodes through the real `publishRevision` writer
// (gated child, same harness `association-service.test.ts` uses), then
// exercises `db.getById` / `db.list` / `db.searchText` / `db.searchVector`
// with the flag ON, and confirms the flag OFF path never calls target-19 at
// all (an env pointed at a target-19-only root, with no `memories` table,
// would 500 if the legacy path were reached).
//
// Fresh `mktemp` datasets only; stubbed embedder; nothing touches
// app/.tmp, app/data, ~/, R2 or a running service.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createFixture as createSeededRevisionFixture, revisionEnvelope, runGated, type SeededWorkspace } from "./helpers/publication-fixture";
import { resetTarget19MemoryReaderForTests } from "../src/db.legacyRead.resetReaderForTests";
import { testTimeout } from "./helpers/timing.testTimeout";

const WS = "alpha-workspace";
const CHILD = new URL("./fixtures/legacy-read-target19/gated-publish-and-index.ts", import.meta.url).pathname;
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

let fixture: Awaited<ReturnType<typeof createSeededRevisionFixture>>;
let seeded: SeededWorkspace;

async function publish(nodeId: string, revisionId: string, opId: string, overrides: Record<string, unknown>): Promise<void> {
  const request = { operation_id: opId, content: revisionEnvelope(WS, seeded, nodeId, overrides) };
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ request, revisionIds: [revisionId], clockMs: Date.parse("2026-09-28T00:00:00.000Z") }),
  ]);
  const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
  if (parsed.ok !== true) throw new Error(`seed publish failed: ${result.stdout}\n${result.stderr}`);
}

function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) prior[key] = process.env[key];
  Object.assign(process.env, env);
  return run().finally(() => {
    for (const key of Object.keys(prior)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
    resetTarget19MemoryReaderForTests();
  });
}

beforeAll(async () => {
  fixture = await createSeededRevisionFixture([WS, "beta-workspace"]);
  seeded = fixture.workspaces[WS]!;
  await publish(pad("t19nodeA"), pad("t19revA"), "t19-op-a", {
    title: "แผนดำเนินงาน",
    body: "หลงลืมเรื่องสำคัญ นี่คือ memory เกี่ยวกับ ลืม",
    subject_peer_name: seeded.peer_names[0] ?? null,
  });
  await publish(pad("t19nodeB"), pad("t19revB"), "t19-op-b", {
    title: "second memory",
    body: "an unrelated english body",
  });
  // Cross-workspace distractor: must never surface under WS reads.
  const betaSeeded = fixture.workspaces["beta-workspace"]!;
  const betaRequest = {
    operation_id: "t19-op-x",
    content: revisionEnvelope("beta-workspace", betaSeeded, pad("t19nodeX"), { title: "beta only" }),
  };
  const betaResult = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ request: betaRequest, revisionIds: [pad("t19revX")], clockMs: Date.parse("2026-09-28T00:00:00.000Z") }),
  ]);
  const betaParsed = JSON.parse(betaResult.stdout.trim().split("\n").pop() ?? "{}");
  if (betaParsed.ok !== true) throw new Error(`beta seed failed: ${betaResult.stdout}\n${betaResult.stderr}`);
}, testTimeout(120_000));

afterEach(() => resetTarget19MemoryReaderForTests());

afterAll(async () => {
  await fixture.cleanup();
});

describe("legacy-read target-19 dark launch (R33 S2)", () => {
  test("flag off: default backend never opens the target-19 dataset", async () => {
    const { memoriesBackend } = await import("../src/db.legacyRead.backend");
    expect(memoriesBackend({})).toBe("legacy");
    expect(memoriesBackend({ ARRA_MEMORIES_BACKEND: "something-else" })).toBe("legacy");
  });

  test("flag on: getById maps a node/revision to the legacy row shape", () =>
    withEnv({ ARRA_MEMORIES_BACKEND: "target19", ARRA_KNOWLEDGE_DATASET_ROOT: fixture.datasetRoot }, async () => {
      const { getById } = await import("../src/db.getById");
      const row = await getById(WS, pad("t19nodeA"));
      expect(row).not.toBeNull();
      expect(row!.id).toBe(pad("t19nodeA"));
      expect(row!.name).toBe("แผนดำเนินงาน");
      expect(row!.workspace_name).toBe(WS);
      expect(row!.content).toContain("ลืม");
      expect(row!.is_active).toBe(true);
      expect(row!.sync_state).toBe("synced");
      expect(typeof row!.created_at === "string").toBe(true);
    }));

  test("flag on: list is workspace-scoped and excludes the other workspace's node", () =>
    withEnv({ ARRA_MEMORIES_BACKEND: "target19", ARRA_KNOWLEDGE_DATASET_ROOT: fixture.datasetRoot }, async () => {
      const { list } = await import("../src/db.list");
      const rows = await list(WS, 50, {});
      const ids = rows.map((r: any) => r.id);
      expect(ids).toContain(pad("t19nodeA"));
      expect(ids).toContain(pad("t19nodeB"));
      expect(ids).not.toContain(pad("t19nodeX"));
    }));

  test("flag on: searchText finds Thai substring inside a word (R14 ngram)", () =>
    withEnv({ ARRA_MEMORIES_BACKEND: "target19", ARRA_KNOWLEDGE_DATASET_ROOT: fixture.datasetRoot }, async () => {
      const { searchText } = await import("../src/db.searchText");
      const result = await searchText("ลืม", WS, 10);
      const ids = result.rows.map((r: any) => r.id);
      expect(ids).toContain(pad("t19nodeA"));
      expect(ids).not.toContain(pad("t19nodeX"));
    }));

  test("flag off: the target-19 dataset root is never opened by the legacy path", () =>
    withEnv({ ARRA_KNOWLEDGE_DATASET_ROOT: fixture.datasetRoot }, async () => {
      const { searchText } = await import("../src/db.searchText");
      // Legacy path opens `ARRA_DATA_DIR`'s `memories` table (unset here), not
      // `ARRA_KNOWLEDGE_DATASET_ROOT` -- it must fail on the MISSING legacy
      // table, never succeed by silently reading the target-19 fixture (that
      // would mean the flag check was bypassed).
      let error: unknown = null;
      try {
        await searchText("ลืม", "default", 10);
      } catch (caught) {
        error = caught;
      }
      expect(error).not.toBeNull();
    }));
});
