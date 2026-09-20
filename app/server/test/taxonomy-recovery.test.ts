/**
 * #27 taxonomy recovery — seed traces, partial resumption and persistence faults.
 *
 * Contract: `app/docs/contracts/taxonomy-write-v1.md`
 * SHA256 4c126a7e8238e858b137b54f7c505125db37526a71d0a04acf6663ff1237df8e
 * Base: 4226126385a89e5136a8bda1490a0f43241acc9e
 *
 * The claims this file is responsible for, and how each is actually shown:
 *
 * * The fresh-seed hook trace is exactly the frozen one — nine
 *   [before_write, after_*_write, after_readback] triples in literal staging
 *   order — AND the persisted rows at every crash prefix are the expected
 *   identities for that prefix. Counts alone cannot say WHICH row was
 *   written, so every prefix is checked against an expected order authored
 *   here, from the contract text, not read back from the implementation.
 * * A resumed seed emits triples only for the rows that are still missing,
 *   completes any matching subset including terms whose vocabulary is absent,
 *   and leaves every already-present row's timestamp untouched.
 * * A changed or retired seed row conflicts. It is never repaired, reset or
 *   silently adopted.
 * * A lost ACK changes nothing: the durable state after the kill is complete,
 *   and the replay is already_satisfied with no mutation boundaries at all.
 * * A REAL SDK mutation failure — not a thrown hook — fail-stops the owner,
 *   and after the filesystem is repaired that same owner still refuses while
 *   a fresh owner succeeds. Without the repair-then-refuse pair, a "fail-stop"
 *   result is indistinguishable from a dataset that simply stayed broken.
 * * Poison is shared in both directions across the knowledge facade.
 *
 * Bounded, and stated plainly: this is process death and SDK-reported failure
 * on local Darwin/POSIX with the pinned Python/Bun. It is not power-loss,
 * filesystem-hardware or multiwriter proof, and the gate remains a cooperative
 * operator protocol.
 *
 * Coverage limit, stated because a green suite invites the opposite
 * assumption: an earlier 16/0 run of this file passed against a source
 * carrying three real defects it does not exercise — a seed shortcut that
 * skips name uniqueness when an ID already matches, a final seed verification
 * that re-encodes without re-comparing the manifest, and shared post-write
 * handling that does not preserve safe errors. Those are core regressions,
 * owned by the service lane; nothing here should be read as evidence about
 * them.
 *
 * Ownership: this file and `test/fixtures/taxonomy-v1/recovery/**` only.
 * Mutator grammar, precedence and ancestry limits belong to the service suite;
 * owner exclusion, alias roots and one-shot close belong to the ownership
 * suite. The accepted #26 files are untouched.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@lancedb/lancedb";
import { PYTHON, runOwnedChild, spawnGatedChild } from "./helpers/publication-fixture";

// ── dependencies ────────────────────────────────────────────────────────────

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url)).replace(/\/test\/?$/, "");
const SERVICE_MODULE = join(SERVER_DIR, "src/publication/service.ts");
const TAXONOMY_HELPER = join(SERVER_DIR, "test/helpers/taxonomy-fixture.ts");
const CHILD_SCRIPT = join(SERVER_DIR, "test/fixtures/taxonomy-v1/recovery/knowledge-child.ts");
const SILENT_CHILD = join(SERVER_DIR, "test/fixtures/taxonomy-v1/recovery/silent-child.ts");
const PY_SRC = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));
const EXPORTER = fileURLToPath(new URL("../../migrate-py/tests/export_taxonomy_fixture.py", import.meta.url));

const MISSING: string[] = [
  [PYTHON, "python interpreter (set ARRA_CONTRACT_PYTHON)"],
  [EXPORTER, "export_taxonomy_fixture.py (#48)"],
  [SERVICE_MODULE, "src/publication/service.ts"],
  [TAXONOMY_HELPER, "test/helpers/taxonomy-fixture.ts (#47)"],
  [CHILD_SCRIPT, "test/fixtures/taxonomy-v1/recovery/knowledge-child.ts"],
]
  .filter(([path]) => !existsSync(path!))
  .map(([, label]) => label!);

// A present service.ts is not yet a taxonomy-capable one: at this base commit
// it exports the publication factories only. This is a bounded SOURCE-TEXT
// check, not module resolution -- it says the symbol is written there, which
// is enough to tell "core has not landed" apart from "core is broken".
if (existsSync(SERVICE_MODULE) && !readFileSync(SERVICE_MODULE, "utf8").includes("openKnowledgeWriter")) {
  MISSING.push("openKnowledgeWriter in src/publication/service.ts (#47)");
}

const PENDING = MISSING.length > 0;
const reason = PENDING ? ` [PENDING: ${MISSING.join(", ")}]` : "";
/** Real fixtures and two or three gated processes per case; 5s is the machinery. */
const CASE_TIMEOUT_MS = 240_000;
type CaseBody = () => void | Promise<unknown>;
const recoveryTest = PENDING
  ? (name: string, fn: CaseBody) => test.skip(name + reason, fn, CASE_TIMEOUT_MS)
  : (name: string, fn: CaseBody) => test(name, fn, CASE_TIMEOUT_MS);

test("preflight: every taxonomy dependency this suite needs is present", () => {
  // Red while pending, so a skipped case is never mistaken for evidence.
  expect(MISSING).toEqual([]);
});

// ── the expected order, authored here from the contract ─────────────────────

/**
 * The literal staging order, transcribed from the contract's bootstrap
 * section: the five `type` terms in their stated order, then the two
 * `memory_horizon` terms, then the two vocabularies in type/horizon order.
 *
 * Written out rather than derived from the helper's builder on purpose. A
 * crash-prefix assertion is only meaningful against an order authored
 * independently of the code that produces it; deriving it from the same
 * source would make the test agree with the implementation by construction.
 */
const TERM_ORDER = ["note", "conclusion", "learning", "discussion", "correction", "short_term", "long_term"] as const;

/** Identities in the exact order the contract says they must be staged. */
type Row = { table: "terms" | "vocabularies"; key: string; id: string };

let idCounter = 0;
/** A distinct, valid nanoid21, authored here rather than taken from a builder. */
function id21(label: string): string {
  idCounter += 1;
  const body = `Tax${label}${idCounter}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return (body + "_".repeat(21)).slice(0, 21);
}

type Manifest = { request: Record<string, unknown>; order: Row[] };

/** One seed request plus the row order its execution must follow. */
function manifest(workspace: string): Manifest {
  const typeVocabulary = id21("TypeVocab");
  const horizonVocabulary = id21("HorizonVocab");
  const termIds = Object.fromEntries(TERM_ORDER.map((name) => [name, id21(name)])) as Record<string, string>;

  const request = {
    workspace_name: workspace,
    type: {
      vocabulary_id: typeVocabulary,
      terms: {
        note: termIds.note,
        conclusion: termIds.conclusion,
        learning: termIds.learning,
        discussion: termIds.discussion,
        correction: termIds.correction,
      },
    },
    memory_horizon: {
      vocabulary_id: horizonVocabulary,
      terms: { short_term: termIds.short_term, long_term: termIds.long_term },
    },
  };

  const order: Row[] = [
    ...TERM_ORDER.map((key) => ({ table: "terms" as const, key, id: termIds[key]! })),
    { table: "vocabularies" as const, key: "type", id: typeVocabulary },
    { table: "vocabularies" as const, key: "memory_horizon", id: horizonVocabulary },
  ];
  return { request, order };
}

/** The complete successful fresh-seed trace, as the contract freezes it. */
function expectedTrace(rows: Row[]): { name: string; n: number }[] {
  const counts: Record<string, number> = {};
  const next = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return { name, n: counts[name]! };
  };
  return rows.flatMap((row) => [
    next("before_write"),
    next(row.table === "terms" ? "after_term_write" : "after_vocabulary_write"),
    next("after_readback"),
  ]);
}

// ── owned scratch ───────────────────────────────────────────────────────────

const scratch: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

async function scratchDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arra-tax-recovery-${tag}-`));
  scratch.push(dir);
  return dir;
}

afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshDataset(workspace = "wsA"): Promise<string> {
  const { createTaxonomyFixture } = await import(TAXONOMY_HELPER);
  const fixture = await createTaxonomyFixture([workspace, "wsB"]);
  cleanups.push(fixture.cleanup);
  return fixture.datasetRoot as string;
}

// ── gated child harness ─────────────────────────────────────────────────────

type Boundary = "before_write" | "after_term_write" | "after_vocabulary_write" | "after_update" | "after_readback";
type Step = { facade: "taxonomy" | "publication"; method: string; request: Record<string, unknown> };

type Plan = {
  datasetRoot: string;
  serviceModule: string;
  clockMs: number[];
  revisionIds: string[];
  parkAt?: { name: Boundary; n: number } | null;
  throwAt?: { name: Boundary; n: number } | null;
  emitPark?: "before_response_emission" | "after_response_emission" | null;
  resumeOnStdin?: boolean;
  parkStep?: number;
  steps: Step[];
};

type ChildEvent = Record<string, any>;

const SEED_CLOCK_MS = 1_789_900_000_000;

function plan(datasetRoot: string, steps: Step[], extra: Partial<Plan> = {}): Plan {
  return {
    datasetRoot,
    serviceModule: SERVICE_MODULE,
    // One sample per staged row, and spares: a seed allocates a timestamp per
    // row it actually writes, and a resumed seed writes fewer.
    clockMs: Array.from({ length: 24 }, (_, i) => SEED_CLOCK_MS + i * 1000),
    revisionIds: Array.from({ length: 8 }, () => id21("Rev")),
    parkAt: null,
    throwAt: null,
    emitPark: null,
    resumeOnStdin: false,
    parkStep: 0,
    steps,
    ...extra,
  };
}

async function writePlan(spec: Plan, tag: string): Promise<string> {
  const dir = await scratchDir(tag);
  const planPath = join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify(spec), "utf8");
  return planPath;
}

/** Launch one gated owner. The caller kills and reaps it in a `finally`. */
async function launch(spec: Plan, tag: string) {
  const planPath = await writePlan(spec, tag);
  return spawnGatedChild(spec.datasetRoot, CHILD_SCRIPT, [planPath], { PYTHONPATH: PY_SRC });
}


/**
 * Acquire the gate in Python, then become the Bun child. Never returns.
 *
 * Used only where the parent must RESUME a parked child: the shared helper's
 * gated spawn ignores stdin by design, and the release has to reach a process
 * that is already blocked inside the hook.
 */
const LAUNCHER_SOURCE = [
  "import sys",
  "from arra_migrate.writer_gate import exec_with_gate",
  "exec_with_gate(sys.argv[1], sys.argv[2:])",
].join("\n");

type ResumableChild = {
  readonly pid: number | undefined;
  /** Next event, bounded by a parent-enforced deadline. */
  nextEvent(deadlineMs?: number): Promise<ChildEvent>;
  /** Release a parked child. */
  resume(): void;
  /** Close the child's stdin, once no further release is coming. */
  endInput(): void;
  /** Await normal exit, bounded. Returns the MEASURED exit code. */
  waitForExit(deadlineMs?: number): Promise<number>;
  /** SIGKILL the exact pid and reap, bounded. Safe to call repeatedly. */
  killAndReap(deadlineMs?: number): Promise<void>;
  /** Bounded, already-drained stderr. */
  stderr(): string;
};

/** Every parent wait in this file is bounded by this, not by the test runner. */
const HANDSHAKE_DEADLINE_MS = 60_000;
/**
 * Cap on RETAINED stderr, in UTF-16 code units (JS string length), not bytes.
 *
 * Stated in the unit actually enforced: multi-byte output occupies fewer
 * units than bytes, so calling this "64 KiB" would overstate what is
 * measured. Draining continues past the cap regardless — the pipe must not
 * fill — only retention stops.
 */
const MAX_CAPTURED_STDERR_UNITS = 64 * 1024;

/** Reject after `ms`, so no parent wait can be unbounded. */
function deadline(ms: number, what: string): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`parent deadline exceeded waiting for ${what}`)), ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

async function launchResumable(spec: Plan, tag: string, script = CHILD_SCRIPT): Promise<ResumableChild> {
  const planPath = await writePlan(spec, tag);
  const child = Bun.spawn([PYTHON, "-c", LAUNCHER_SOURCE, spec.datasetRoot, process.execPath, script, planPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PYTHONPATH: PY_SRC },
  });

  // stderr is drained continuously and capped: an undrained pipe can fill and
  // block the child, which would look like a hang rather than an error.
  let stderrText = "";
  const drain = (async () => {
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const chunk = decoder.decode(value, { stream: true });
      // Only the REMAINING capacity is kept. Appending a whole chunk merely
      // because the buffer was under the cap would let one large chunk carry
      // the total past it, which is the bound quietly not holding.
      const room = MAX_CAPTURED_STDERR_UNITS - stderrText.length;
      if (room > 0) stderrText += chunk.slice(0, room);
    }
  })();
  drain.catch(() => undefined);

  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reaped: Promise<void> | null = null;

  const killAndReap = async (ms = HANDSHAKE_DEADLINE_MS): Promise<void> => {
    if (reaped === null) {
      reaped = (async () => {
        try {
          child.kill(9); // exact owned pid, never a pattern
        } catch {
          /* already gone */
        }
        const bound = deadline(ms, "the child to be reaped");
        try {
          await Promise.race([child.exited, bound.promise]);
        } finally {
          bound.cancel();
        }
      })();
    }
    return reaped;
  };

  return {
    get pid() {
      return child.pid;
    },
    async nextEvent(ms = HANDSHAKE_DEADLINE_MS) {
      const bound = deadline(ms, "a child event");
      try {
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.length > 0) return JSON.parse(line) as ChildEvent;
            continue;
          }
          const next = await Promise.race([reader.read(), bound.promise]);
          if (next.done) throw new Error(`child stream ended: ${stderrText.slice(0, 400)}`);
          buffer += decoder.decode(next.value, { stream: true });
        }
      } catch (error) {
        // A missed handshake means this child is never finishing on its own.
        await killAndReap(ms);
        throw error;
      } finally {
        bound.cancel();
      }
    },
    resume() {
      child.stdin.write("go\n");
      child.stdin.flush();
    },
    endInput() {
      child.stdin.end();
    },
    async waitForExit(ms = HANDSHAKE_DEADLINE_MS) {
      const bound = deadline(ms, "the child to exit");
      try {
        // MEASURED, never assumed: a fabricated rc would hide a child that
        // died on the way to the result it just printed.
        return await Promise.race([child.exited, bound.promise]);
      } catch (error) {
        await killAndReap(ms);
        throw error;
      } finally {
        bound.cancel();
      }
    },
    killAndReap,
    stderr: () => stderrText,
  };
}

type ChildRun = { events: ChildEvent[]; exitCode: number; stderr: string };

/** Run a plan to completion, collecting every event line. */
async function run(spec: Plan, tag: string): Promise<ChildRun> {
  const child = await launch(spec, tag);
  const events: ChildEvent[] = [];
  try {
    for (;;) {
      let line: string;
      try {
        line = await child.nextLine();
      } catch {
        break; // the child exited; its events are whatever it managed to say
      }
      if (line.trim().length > 0) events.push(JSON.parse(line));
      if (events.at(-1)?.event === "done") break;
    }
    const exitCode = await child.wait();
    return { events, exitCode, stderr: child.stderr };
  } finally {
    child.kill();
    await child.wait().catch(() => undefined);
  }
}

/** Run until the child says it parked, then SIGKILL its exact pid. */
async function runAndKillAtPark(spec: Plan, tag: string): Promise<ChildRun> {
  const child = await launch(spec, tag);
  const events: ChildEvent[] = [];
  try {
    for (;;) {
      const line = await child.nextLine();
      if (line.trim().length === 0) continue;
      const event = JSON.parse(line);
      events.push(event);
      if (event.event === "parked" || event.event === "pre_emit" || event.event === "post_emit") break;
    }
    child.kill();
    const exitCode = await child.wait();
    return { events, exitCode, stderr: child.stderr };
  } finally {
    child.kill();
    await child.wait().catch(() => undefined);
  }
}

function trace(run: ChildRun): { name: string; n: number }[] {
  return run.events.filter((e) => e.event === "boundary").map((e) => ({ name: e.name, n: e.n }));
}

function stepResult(run: ChildRun, step = 0): { ok: boolean; value?: any; error?: any } {
  const event = run.events.find((e) => e.event === "step_result" && e.step === step);
  if (event === undefined) {
    throw new Error(`no step_result ${step}; events ${JSON.stringify(run.events)}\n${run.stderr}`);
  }
  return event.ok ? { ok: true, value: event.value } : { ok: false, error: event.error };
}

function okValue(run: ChildRun, step = 0): any {
  const result = stepResult(run, step);
  if (!result.ok) throw new Error(`step ${step} failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

function errorOf(run: ChildRun, step = 0): Record<string, unknown> {
  const result = stepResult(run, step);
  if (result.ok) throw new Error(`step ${step} unexpectedly succeeded: ${JSON.stringify(result.value)}`);
  return result.error;
}

// ── durable evidence, read-only and gateless ────────────────────────────────

function rawCell(column: any, rowIndex: number): unknown {
  if (!column.isValid(rowIndex)) return null;
  let offset = 0;
  for (const chunk of column.data) {
    if (rowIndex < offset + chunk.length) {
      const values = chunk.values;
      if (values instanceof BigInt64Array) return values[chunk.offset + (rowIndex - offset)]!;
      break;
    }
    offset += chunk.length;
  }
  const value = column.get(rowIndex);
  return typeof value === "bigint" || typeof value === "boolean" || value === null ? value : String(value);
}

async function rawRows(datasetRoot: string, table: string): Promise<Record<string, unknown>[]> {
  const db = await connect(datasetRoot, { readConsistencyInterval: 0 });
  const handle = await db.openTable(table);
  await handle.checkoutLatest();
  const arrow = await handle.query().toArrow();
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < arrow.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const field of arrow.schema.fields) row[field.name] = rawCell(arrow.getChild(field.name), i);
    rows.push(row);
  }
  return rows;
}

/** Which manifest rows are durably present, in the manifest's own order. */
async function persistedPrefix(datasetRoot: string, rows: Row[]): Promise<Row[]> {
  const terms = new Set((await rawRows(datasetRoot, "terms")).map((row) => row.id as string));
  const vocabularies = new Set((await rawRows(datasetRoot, "vocabularies")).map((row) => row.id as string));
  return rows.filter((row) => (row.table === "terms" ? terms : vocabularies).has(row.id));
}

async function createdAtById(datasetRoot: string, table: string): Promise<Record<string, unknown>> {
  const rows = await rawRows(datasetRoot, table);
  return Object.fromEntries(rows.map((row) => [row.id as string, row.created_at]));
}

async function durableSnapshot(datasetRoot: string): Promise<Record<string, string[]>> {
  const stringify = (rows: Record<string, unknown>[]) =>
    rows
      .map((row) => JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)))
      .sort();
  return {
    terms: stringify(await rawRows(datasetRoot, "terms")),
    vocabularies: stringify(await rawRows(datasetRoot, "vocabularies")),
  };
}

// ── gate-held synthetic mutation, for the conflict states ───────────────────

/**
 * Change a seeded row under the REAL gate.
 *
 * A renamed or retired reserved term cannot be produced through the kernel's
 * own bootstrap — it refuses — so the conflict states are written here,
 * holding the lock a writer would hold, into this file's own disposable
 * dataset.
 */
const MUTATE_SOURCE = `
import json, sys

import lancedb
from arra_migrate.writer_gate import writer_gate

root = sys.argv[1]
plan = json.loads(open(sys.argv[2]).read())

with writer_gate(root):
    db = lancedb.connect(root)
    for item in plan:
        table = db.open_table(item["table"])
        result = table.update(where=item["where"], values=item["values"])
        if getattr(result, "rows_updated", 1) == 0:
            raise SystemExit("update matched no rows: " + item["where"])
print(json.dumps({"ok": True}))
`;

async function mutateUnderGate(
  datasetRoot: string,
  updates: { table: string; where: string; values: Record<string, unknown> }[],
): Promise<void> {
  const dir = await scratchDir("mutate");
  const planPath = join(dir, "updates.json");
  await writeFile(planPath, JSON.stringify(updates), "utf8");
  const result = await runOwnedChild(PYTHON, ["-c", MUTATE_SOURCE, datasetRoot, planPath]);
  if (result.code !== 0) throw new Error(`gated mutation failed (${result.code}): ${result.stderr.slice(0, 400)}`);
}


/**
 * Make a Lance table directory writable or not, all the way down.
 *
 * Measured point, and the reason this is not a one-line chmod: taking write
 * permission off the DATASET ROOT alone does not stop appends into a table
 * subdirectory that already exists — the new files land inside
 * `<table>.lance/`, whose mode never changed. So the table directory and
 * every directory beneath it are chmodded, children first when locking (so
 * they are still reachable) and parents first when repairing.
 */
async function chmodTree(root: string, mode: number, deepestFirst: boolean): Promise<void> {
  const dirs = [root];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string });
    dirs.push(join(parent.parentPath ?? parent.path ?? root, entry.name));
  }
  const depth = (path: string) => path.split("/").length;
  dirs.sort((a, b) => (deepestFirst ? depth(b) - depth(a) : depth(a) - depth(b)));
  for (const dir of dirs) await chmod(dir, mode);
}

const seedStep = (request: Record<string, unknown>): Step => ({
  facade: "taxonomy",
  method: "seedReservedVocabularies",
  request,
});

// ── T1. the frozen fresh-seed trace and its persisted identities ────────────

recoveryTest("T1 a fresh seed emits exactly the frozen trace and persists all nine identities", async () => {
  const root = await freshDataset();
  const { request, order } = manifest("wsA");

  const result = await run(plan(root, [seedStep(request)]), "t1");
  const outcome = okValue(result);
  expect(outcome.outcome).toBe("created");

  // The complete trace: nine triples, in staging order, with the totals the
  // contract freezes (9 before_write, 7 after_term_write, 2 after_vocabulary
  // _write, 9 after_readback).
  expect(trace(result)).toEqual(expectedTrace(order));
  const names = trace(result).map((entry) => entry.name);
  expect(names.filter((n) => n === "before_write")).toHaveLength(9);
  expect(names.filter((n) => n === "after_term_write")).toHaveLength(7);
  expect(names.filter((n) => n === "after_vocabulary_write")).toHaveLength(2);
  expect(names.filter((n) => n === "after_readback")).toHaveLength(9);

  // Identities, not counts: the rows that exist are exactly the manifest's.
  expect(await persistedPrefix(root, order)).toEqual(order);
  expect((await rawRows(root, "terms")).length).toBe(7);
  expect((await rawRows(root, "vocabularies")).length).toBe(2);
});

// ── T2. crash prefixes: which rows exist, not how many ──────────────────────

for (const prefix of [0, 1, 4, 7, 8]) {
  recoveryTest(`T2 a kill before staged row ${prefix} leaves exactly the first ${prefix} manifest rows`, async () => {
    const root = await freshDataset();
    const { request, order } = manifest("wsA");

    // Park at the (prefix+1)-th before_write: the SDK call for row `prefix`
    // has not been made yet, so rows 0..prefix-1 are the durable ones.
    const killed = await runAndKillAtPark(
      plan(root, [seedStep(request)], { parkAt: { name: "before_write", n: prefix + 1 } }),
      `t2-${prefix}`,
    );
    expect(killed.events.at(-1)?.event).toBe("parked");

    expect(await persistedPrefix(root, order)).toEqual(order.slice(0, prefix));
    const terms = order.slice(0, prefix).filter((row) => row.table === "terms").length;
    expect((await rawRows(root, "terms")).length).toBe(terms);
    expect((await rawRows(root, "vocabularies")).length).toBe(prefix - terms);
  });
}

// ── T3. resumption from an arbitrary matching subset ────────────────────────

recoveryTest("T3 a resumed seed emits triples only for the missing rows and keeps the present ones", async () => {
  const root = await freshDataset();
  const { request, order } = manifest("wsA");

  await runAndKillAtPark(
    plan(root, [seedStep(request)], { parkAt: { name: "before_write", n: 5 } }),
    "t3-crash",
  );
  const present = order.slice(0, 4);
  expect(await persistedPrefix(root, order)).toEqual(present);
  const termTimes = await createdAtById(root, "terms");

  // A different clock, so a rewritten row would be visible as a new timestamp.
  const resumed = await run(
    plan(root, [seedStep(request)], { clockMs: Array.from({ length: 24 }, (_, i) => SEED_CLOCK_MS + 500_000 + i * 1000) }),
    "t3-resume",
  );
  expect(okValue(resumed).outcome).toBe("created");

  // Triples ONLY for the five still-missing rows, in the same filtered order.
  expect(trace(resumed)).toEqual(expectedTrace(order.slice(4)));
  expect(await persistedPrefix(root, order)).toEqual(order);

  // The rows that were already there were skipped, not rewritten.
  const after = await createdAtById(root, "terms");
  for (const row of present) {
    expect(after[row.id]).toBe(termTimes[row.id]);
  }
});

recoveryTest("T4 terms present with their vocabulary absent is a resumable state, not corruption", async () => {
  const root = await freshDataset();
  const { request, order } = manifest("wsA");

  // Kill after all seven terms and before the first vocabulary: the state the
  // staging order actually produces.
  await runAndKillAtPark(
    plan(root, [seedStep(request)], { parkAt: { name: "before_write", n: 8 } }),
    "t4-crash",
  );
  expect((await rawRows(root, "terms")).length).toBe(7);
  expect((await rawRows(root, "vocabularies")).length).toBe(0);
  const termTimes = await createdAtById(root, "terms");

  const resumed = await run(
    plan(root, [seedStep(request)], { clockMs: Array.from({ length: 24 }, (_, i) => SEED_CLOCK_MS + 900_000 + i * 1000) }),
    "t4-resume",
  );
  expect(okValue(resumed).outcome).toBe("created");
  // Only the two vocabularies are staged.
  expect(trace(resumed)).toEqual(expectedTrace(order.slice(7)));
  expect(await persistedPrefix(root, order)).toEqual(order);
  expect(await createdAtById(root, "terms")).toEqual(termTimes);
});

recoveryTest("T5 a complete seed replays as already_satisfied with NO mutation boundaries", async () => {
  const root = await freshDataset();
  const { request, order } = manifest("wsA");
  await run(plan(root, [seedStep(request)]), "t5-first");
  const snapshot = await durableSnapshot(root);

  const replay = await run(
    plan(root, [seedStep(request)], { clockMs: Array.from({ length: 24 }, (_, i) => SEED_CLOCK_MS + 1_500_000 + i * 1000) }),
    "t5-replay",
  );
  expect(okValue(replay).outcome).toBe("already_satisfied");
  expect(trace(replay)).toEqual([]);
  expect(await durableSnapshot(root)).toEqual(snapshot);
  expect(await persistedPrefix(root, order)).toEqual(order);
});

// ── T6. changed and retired seed rows conflict ──────────────────────────────

for (const change of [
  { label: "renamed", values: { name: "note_renamed" } },
  { label: "retired", values: { is_active: false } },
] as const) {
  recoveryTest(`T6 a ${change.label} reserved term conflicts and is not repaired`, async () => {
    const root = await freshDataset();
    const { request, order } = manifest("wsA");
    await run(plan(root, [seedStep(request)]), `t6-${change.label}-seed`);

    const note = order.find((row) => row.key === "note")!;
    await mutateUnderGate(root, [
      { table: "terms", where: `id = '${note.id}'`, values: { ...change.values } },
    ]);
    const snapshot = await durableSnapshot(root);

    const replay = await run(plan(root, [seedStep(request)]), `t6-${change.label}-replay`);
    const error = errorOf(replay);
    expect(error.version).toBe("arra-taxonomy-error/v1");
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("taxonomy state conflict");
    // No repair, no reset, no second row: the evidence is preserved.
    expect(await durableSnapshot(root)).toEqual(snapshot);
    expect(trace(replay)).toEqual([]);
  });
}

// ── T7. lost ACK ────────────────────────────────────────────────────────────

recoveryTest("T7 a seed killed after its last write but before the ACK is complete and replays clean", async () => {
  const root = await freshDataset();
  const { request, order } = manifest("wsA");

  const killed = await runAndKillAtPark(
    plan(root, [seedStep(request)], { emitPark: "before_response_emission" }),
    "t7-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("pre_emit");
  // The caller never learned the outcome; the dataset did.
  expect(killed.events.some((event) => event.event === "step_result")).toBe(false);
  expect(trace(killed)).toEqual(expectedTrace(order));
  expect(await persistedPrefix(root, order)).toEqual(order);
  const snapshot = await durableSnapshot(root);

  const replay = await run(plan(root, [seedStep(request)]), "t7-replay");
  expect(okValue(replay).outcome).toBe("already_satisfied");
  expect(trace(replay)).toEqual([]);
  expect(await durableSnapshot(root)).toEqual(snapshot);
});

// ── T8. a REAL SDK failure, repaired, and still refused ─────────────────────

recoveryTest("T8 a real SDK write failure fail-stops the owner, and a REPAIRED filesystem does not un-poison it", async () => {
  const root = await freshDataset();
  const { request, order } = manifest("wsA");
  const table = join(root, "terms.lance");

  // The ordering is the whole point of this case, so the parent commands
  // every step of it and the child cannot advance on its own:
  //   park before the first append -> parent LOCKS the table
  //   -> release -> real SDK failure -> child parks with its result reported
  //   -> parent REPAIRS the table -> release -> second request on the SAME owner
  // Only that sequence can tell a poisoned owner apart from a dataset that
  // was still broken when the second request ran.
  const child = await launchResumable(
    plan(root, [seedStep(request), seedStep(request)], {
      parkAt: { name: "before_write", n: 1 },
      emitPark: "after_response_emission",
      resumeOnStdin: true,
    }),
    "t8",
  );
  const events: ChildEvent[] = [];
  const nextUntil = async (kind: string): Promise<ChildEvent> => {
    for (;;) {
      const event = await child.nextEvent();
      events.push(event);
      if (event.event === kind) return event;
    }
  };

  let exitCode: number;
  try {
    await nextUntil("parked");
    await chmodTree(table, 0o500, true);
    child.resume();

    // The first request fails against a genuinely unwritable table.
    await nextUntil("step_result");
    await nextUntil("post_emit");

    // REPAIRED here, with the child parked and provably not yet in its second
    // request. Asserted rather than assumed: a writable directory is the
    // precondition the rest of this case rests on.
    await chmodTree(table, 0o700, false);
    await access(table, constants.W_OK);

    child.resume();
    // No further release is coming; leaving stdin open would keep a finished
    // child alive and make its exit code unobservable.
    child.endInput();
    await nextUntil("done");
    exitCode = await child.waitForExit();
  } finally {
    await chmodTree(table, 0o700, false).catch(() => undefined);
    await child.killAndReap();
  }

  // Measured, not constructed: the child completed on its own.
  expect(exitCode).toBe(0);
  const result: ChildRun = { events, exitCode, stderr: child.stderr() };

  // The handshakes happened in the order the argument depends on.
  expect(events.map((event) => event.event).filter((name) => name !== "boundary")).toEqual([
    "ready",
    "parked",
    "step_result",
    "post_emit",
    "step_result",
    "done",
  ]);

  const first = errorOf(result, 0);
  expect(first.version).toBe("arra-taxonomy-error/v1");
  expect(first.code).toBe("recovery_required");
  expect(first.message).toBe("writer recovery required");

  // The second request ran AFTER the repair and is still refused, so the
  // refusal is the owner's state and not the filesystem's.
  const second = errorOf(result, 1);
  expect(second.code).toBe("recovery_required");

  // And the dataset really is usable again: a fresh owner completes the seed.
  const fresh = await run(plan(root, [seedStep(request)]), "t8-fresh");
  expect(okValue(fresh).outcome).toBe("created");
  expect(await persistedPrefix(root, order)).toEqual(order);
});

recoveryTest("T8b the parent's own deadline fires: a silent child is killed and reaped", async () => {
  // Sensitivity for the harness itself. Every case above trusts these
  // deadlines; a timeout that never trips looks exactly like one that does
  // not work, and the suite runner's timeout is not evidence of parent-side
  // cleanup.
  const root = await freshDataset();
  const child = await launchResumable(plan(root, []), "t8b", SILENT_CHILD);
  const configuredMs = 1_500;
  const started = Bun.nanoseconds();
  let failure: unknown;
  try {
    await child.nextEvent(configuredMs);
  } catch (error) {
    failure = error;
  }
  const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
  expect(String((failure as Error)?.message)).toContain("parent deadline exceeded");
  // The deadline is CONFIGURED at 1.5s. What is asserted is that it waited
  // roughly that long -- so it was the deadline firing and not some unrelated
  // immediate failure -- and that it returned far inside the runner's own
  // timeout. Scheduling jitter makes a strict upper bound of 1.5s a flaky
  // claim, so it is not made.
  expect(elapsedMs).toBeGreaterThan(configuredMs * 0.9);
  expect(elapsedMs).toBeLessThan(30_000);
  // nextEvent kills and reaps on the way out, so this returns immediately.
  await child.killAndReap(5_000);
});

// ── T9. poison is shared across the knowledge facade, both ways ─────────────

recoveryTest("T9 a taxonomy fail-stop refuses the publication facade on the same owner", async () => {
  const root = await freshDataset();
  const { request } = manifest("wsA");

  // A thrown hook AFTER an attempted write is a legitimate poison trigger and
  // is tested here as itself -- separately from T8's real SDK failure, which
  // is the evidence that the fail-stop path is not hook-only.
  const result = await run(
    plan(
      root,
      [
        seedStep(request),
        {
          facade: "publication",
          method: "getAcceptedHead",
          request: { workspace_name: "wsA", node_id: id21("Node") },
        },
      ],
      { throwAt: { name: "after_term_write", n: 1 } },
    ),
    "t9",
  );

  const seedError = errorOf(result, 0);
  expect(seedError.code).toBe("recovery_required");
  // Reads stay available on a poisoned owner (contract §50), so the read
  // above must SUCCEED -- it is the write side that is refused. `null` is the
  // correct answer for an absent node.
  const read = stepResult(result, 1);
  expect(read.ok).toBe(true);
  expect(read.value).toBeNull();
});

recoveryTest("T9b a poisoned owner refuses a publication WRITE, not only further taxonomy writes", async () => {
  const root = await freshDataset();
  const { request } = manifest("wsA");

  const result = await run(
    plan(
      root,
      [
        seedStep(request),
        {
          facade: "publication",
          method: "publishRevision",
          request: {
            operation_id: "op-t9b",
            content: {
              workspace_name: "wsA",
              node_id: id21("Node"),
              base_revision_id: null,
              title: "poisoned",
              body: "body",
              body_format: "text",
              fields: "{}",
              author_peer_name: null,
              observer_peer_name: null,
              subject_peer_name: null,
              session_name: null,
              is_active: true,
              valid_from: null,
              valid_to: null,
              change_reason: null,
              schema_version: "1",
              canonical_version: "arra-revision/v1",
              term_snapshot_json: "[]",
              link_snapshot_json: "[]",
              h_metadata: null,
              internal_metadata: null,
            },
          },
        },
      ],
      { throwAt: { name: "after_term_write", n: 1 } },
    ),
    "t9b",
  );

  expect(errorOf(result, 0).code).toBe("recovery_required");
  // The publication write is refused for the owner's state, before any
  // publication-specific validation of the request could apply.
  expect(errorOf(result, 1).code).toBe("recovery_required");
  // And nothing of that seed's partial work was rolled back.
  expect((await rawRows(root, "terms")).length).toBeGreaterThan(0);
});
