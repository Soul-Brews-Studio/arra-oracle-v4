/**
 * #28 read-cursor recovery — lost ACK, fail-stop and real SDK failures (#73).
 *
 * Contract: `app/docs/contracts/read-cursor-v1.md`
 * Authored against SHA256
 *   164d3e91211552e5146b36d8d8e0cb22a628e4aa7f22d1fe2b70ae9a9f6a9508
 * Current SHA256
 *   04f553dd20f572d6bc9c83b1c8752e69018ff5556ad2b2b1b1308162ca82f24f
 * The difference is a §8 ownership correction only; §§1–7, which is everything
 * this file tests against, are unchanged between the two.
 * Base: d42ee3e9ef563547ceca128e0d1719bf3386ef56
 *
 * What this file is responsible for, per §8 Recovery:
 *
 * * Lost ACK on BOTH write paths — the append that creates a row and the
 *   update that advances one — with the exact prior and desired full rows
 *   asserted, and the retry returning the RETAINED timestamp rather than a
 *   fresh sample.
 * * The retained-null-pointer advance, which §5 requires to be exercised as a
 *   composed statement: the `IS NULL` predicate guard, the TIMESTAMP(6)
 *   assignment and the readback together. Separate accepted uses of each
 *   primitive are feasibility, not a measurement of that statement.
 * * Retry is CONDITIONAL, not total. A later legitimate advance turns an old
 *   retry into a conflict, and that is correct behaviour rather than a failure
 *   of recovery — the case exists so the distinction is measured rather than
 *   asserted in prose.
 * * Safe pre-write refusal leaves the owner usable; any failure after the
 *   attempted write poisons it. Only the owner's state afterwards separates
 *   them.
 * * Real SDK failures at the append, the update and the readback, each with
 *   the parent's repair asserted as an observed handshake point BEFORE the
 *   same-owner second request. Never a repair in `finally`.
 * * Post-readback classification per §5: duplicate or malformed retained state
 *   is `integrity_failure` + poison; a well-formed unexpected state is
 *   `recovery_required` + poison. Both are reached by an INSTRUMENTED
 *   raw-storage interleave inside the gated child itself — see section I.
 *
 * Bounded claims: process death and SDK-reported failure on local Darwin/POSIX
 * with pinned Python/Bun. Not power loss, not filesystem hardware, not
 * multiwriter. The gate stays a cooperative operator protocol.
 *
 * Cleanup is by CREATION RECORD: every dataset and scratch root is registered
 * when it is made and removed by path, never by prefix or mtime.
 *
 * Ownership: this file and `test/fixtures/read-cursor-v1/recovery/**` only.
 */
import { afterAll, expect, test } from "bun:test";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@lancedb/lancedb";
import { PYTHON, runOwnedChild } from "./helpers/publication-fixture";
import { createContextFixture } from "./helpers/context-fixture";

// ── dependencies ────────────────────────────────────────────────────────────

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url)).replace(/\/test\/?$/, "");
const SERVICE_MODULE = join(SERVER_DIR, "src/publication/service.ts");
const RECOVERY_DIR = join(SERVER_DIR, "test/fixtures/read-cursor-v1/recovery");
const CURSOR_CHILD = join(RECOVERY_DIR, "cursor-child.ts");
const SILENT_CHILD = join(RECOVERY_DIR, "silent-child.ts");
const PY_SRC = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));

const MISSING: string[] = [
  [PYTHON, "python interpreter (set ARRA_CONTRACT_PYTHON)"],
  [SERVICE_MODULE, "src/publication/service.ts"],
  [CURSOR_CHILD, "fixtures/read-cursor-v1/recovery/cursor-child.ts"],
  [SILENT_CHILD, "fixtures/read-cursor-v1/recovery/silent-child.ts"],
]
  .filter(([path]) => !existsSync(path!))
  .map(([, label]) => label!);

// Bounded SOURCE-TEXT check, labelled as such: it separates "core has not
// landed" from "core is broken", and it is not module resolution.
if (existsSync(SERVICE_MODULE)) {
  const source = readFileSync(SERVICE_MODULE, "utf8");
  for (const symbol of ["advanceReadCursor", "getReadCursor"]) {
    if (!source.includes(symbol)) MISSING.push(`${symbol} in src/publication/service.ts`);
  }
}

const PENDING = MISSING.length > 0;
const reason = PENDING ? ` [PENDING: ${MISSING.join(", ")}]` : "";
const CASE_TIMEOUT_MS = 300_000;
type CaseBody = () => void | Promise<unknown>;
const recoveryTest = PENDING
  ? (name: string, fn: CaseBody) => test.skip(name + reason, fn, CASE_TIMEOUT_MS)
  : (name: string, fn: CaseBody) => test(name, fn, CASE_TIMEOUT_MS);

test("preflight: every read-cursor dependency this suite needs is present", () => {
  // Red while pending. A skipped case is never acceptance.
  expect(MISSING).toEqual([]);
});

// ── creation records ────────────────────────────────────────────────────────

const createdRoots: { path: string; cleanup?: () => Promise<void> }[] = [];

async function scratchDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arra-cursor-recovery-${tag}-`));
  createdRoots.push({ path: dir });
  return dir;
}

afterAll(async () => {
  const stranded: string[] = [];
  for (const record of createdRoots.splice(0)) {
    try {
      if (record.cleanup !== undefined) await record.cleanup();
      else await rm(record.path, { recursive: true, force: true });
    } catch (error) {
      stranded.push(`${record.path}: ${String((error as Error)?.message ?? error)}`);
    }
  }
  if (stranded.length > 0) throw new Error(`teardown could not remove:\n${stranded.join("\n")}`);
});

// ── identities, authored here ───────────────────────────────────────────────

const WORKSPACE = "alpha-workspace";
const SESSION = "cursor-session";
const PEER = "cursor-peer";

let idCounter = 0;
function id21(label: string): string {
  idCounter += 1;
  const body = `Cur${label}${idCounter}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return (body + "_".repeat(21)).slice(0, 21);
}

const CLOCK_MS = 1_789_940_000_000;

// ── child harness ───────────────────────────────────────────────────────────

type Boundary = "before_write" | "after_write" | "after_readback";
type Step = { facade: "context" | "publication" | "taxonomy"; method: string; request: Record<string, unknown> };
type ChildEvent = Record<string, any>;

type Plan = {
  datasetRoot: string;
  serviceModule: string;
  sourceNamespace: string | null;
  clockMs: number[];
  revisionIds: string[];
  parkAt?: { name: Boundary; n: number } | null;
  throwAt?: { name: Boundary; n: number } | null;
  /** Instrumented raw-storage interleave, planted by the child in-process. */
  injectAt?: { name: Boundary; n: number } | null;
  injection?: Record<string, unknown> | null;
  emitPark?: "before_response_emission" | "after_response_emission" | null;
  resumeOnStdin?: boolean;
  parkStep?: number;
  steps: Step[];
};

const HANDSHAKE_DEADLINE_MS = 60_000;
/** Retained stderr cap, in UTF-16 code units (JS string length), not bytes. */
const MAX_CAPTURED_STDERR_UNITS = 64 * 1024;

const LAUNCHER_SOURCE = [
  "import sys",
  "from arra_migrate.writer_gate import exec_with_gate",
  "exec_with_gate(sys.argv[1], sys.argv[2:])",
].join("\n");

function plan(datasetRoot: string, steps: Step[], extra: Partial<Plan> = {}): Plan {
  return {
    datasetRoot,
    serviceModule: SERVICE_MODULE,
    sourceNamespace: null,
    clockMs: Array.from({ length: 48 }, (_, i) => CLOCK_MS + i * 1000),
    revisionIds: Array.from({ length: 8 }, () => id21("Rev")),
    parkAt: null,
    throwAt: null,
    injectAt: null,
    injection: null,
    emitPark: null,
    resumeOnStdin: false,
    parkStep: 0,
    steps,
    ...extra,
  };
}

function deadline(ms: number, what: string): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`parent deadline exceeded waiting for ${what}`)), ms);
  });
  return { promise, cancel: () => (timer === undefined ? undefined : clearTimeout(timer)) };
}

type Child = {
  nextEvent(deadlineMs?: number): Promise<ChildEvent>;
  resume(): void;
  endInput(): void;
  waitForExit(deadlineMs?: number): Promise<number>;
  killAndReap(deadlineMs?: number): Promise<void>;
  stderr(): string;
};

async function launch(spec: Plan, tag: string, script = CURSOR_CHILD): Promise<Child> {
  const dir = await scratchDir(tag);
  const planPath = join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify(spec), "utf8");

  const child = Bun.spawn([PYTHON, "-c", LAUNCHER_SOURCE, spec.datasetRoot, process.execPath, script, planPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PYTHONPATH: PY_SRC },
  });

  let stderrText = "";
  const drain = (async () => {
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const chunk = decoder.decode(value, { stream: true });
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
        return await Promise.race([child.exited, bound.promise]); // measured, never constructed
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

type Run = { events: ChildEvent[]; exitCode: number; stderr: string };

async function run(spec: Plan, tag: string): Promise<Run> {
  const child = await launch(spec, tag);
  const events: ChildEvent[] = [];
  try {
    child.endInput();
    for (;;) {
      const event = await child.nextEvent();
      events.push(event);
      if (event.event === "done") break;
    }
    return { events, exitCode: await child.waitForExit(), stderr: child.stderr() };
  } finally {
    await child.killAndReap();
  }
}

async function runAndKillAtPark(spec: Plan, tag: string): Promise<Run> {
  const child = await launch(spec, tag);
  const events: ChildEvent[] = [];
  try {
    for (;;) {
      const event = await child.nextEvent();
      events.push(event);
      if (event.event === "parked" || event.event === "pre_emit") break;
    }
    await child.killAndReap();
    // -1 records that the parent ended it rather than that it completed.
    return { events, exitCode: -1, stderr: child.stderr() };
  } finally {
    await child.killAndReap();
  }
}

const trace = (result: Run): string[] =>
  result.events.filter((e) => e.event === "boundary").map((e) => `${e.name}#${e.n}`);

/** One mutation fires exactly this triple; reads, replays and conflicts fire nothing. */
const MUTATION_TRIPLE = ["before_write#1", "after_write#1", "after_readback#1"];

/**
 * The ordered event stream, up to and including the first step result.
 *
 * Boundaries and harness events in one sequence, because for the instrumented
 * cases the ORDER is the claim: the fault must land after the write boundary
 * and before any readback boundary. A set of events, or a `some()` check,
 * would pass for an injection that happened somewhere else entirely.
 */
function sequenceThroughFirstResult(result: Run): string[] {
  const labels = result.events.map((event) =>
    event.event === "boundary" || event.event === "injected"
      ? `${event.event}:${event.name}#${event.n}`
      : event.event === "step_result"
        ? `step_result:${event.step}`
        : event.event,
  );
  const first = labels.findIndex((label) => label.startsWith("step_result:"));
  return first === -1 ? labels : labels.slice(0, first + 1);
}

/** The exact injected event, so the COMMANDED occurrence is what fired. */
function injectedEvent(result: Run): ChildEvent | undefined {
  const event = result.events.find((entry) => entry.event === "injected");
  return event === undefined ? undefined : { event: event.event, name: event.name, n: event.n, step: event.step };
}

function stepResult(result: Run, step = 0): { ok: boolean; value?: any; error?: any } {
  const event = result.events.find((e) => e.event === "step_result" && e.step === step);
  if (event === undefined) {
    throw new Error(`no step_result ${step}; events ${JSON.stringify(result.events)}\n${result.stderr}`);
  }
  return event.ok ? { ok: true, value: event.value } : { ok: false, error: event.error };
}

function okValue(result: Run, step = 0): any {
  const outcome = stepResult(result, step);
  if (!outcome.ok) throw new Error(`step ${step} failed: ${JSON.stringify(outcome.error)}`);
  return outcome.value;
}

function errorOf(result: Run, step = 0): Record<string, unknown> {
  const outcome = stepResult(result, step);
  if (outcome.ok) throw new Error(`step ${step} unexpectedly succeeded: ${JSON.stringify(outcome.value)}`);
  return outcome.error;
}

const PUBLICATION_ENVELOPE = "arra-publication-error/v1";
const MESSAGES = {
  invalid_request: "invalid publication request",
  invalid_reference: "invalid scoped reference",
  integrity_failure: "stored state failed integrity validation",
  recovery_required: "writer recovery required",
} as const;

/** A THROWN error: class name AND all four wire fields, message included. */
function expectThrown(
  actual: Record<string, unknown> | undefined,
  expected: { name: string; version: string; code: keyof typeof MESSAGES; path: string },
): void {
  expect({
    name: actual?.name,
    version: actual?.version,
    code: actual?.code,
    path: actual?.path,
    message: actual?.message,
  }).toEqual({ ...expected, message: MESSAGES[expected.code] });
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

/** The complete physical cursor rows, with raw Int64 microseconds preserved. */
async function cursorRows(datasetRoot: string): Promise<Record<string, unknown>[]> {
  return rawRows(datasetRoot, "read_cursors");
}

/** The authored expectation for one stored cursor row, in physical field order. */
function expectedCursorRow(pointer: string | null, micros: bigint): Record<string, unknown> {
  return {
    workspace_name: WORKSPACE,
    peer_name: PEER,
    session_name: SESSION,
    last_read_message_id: pointer,
    last_read_at: micros,
  };
}

const wireTimestamp = (micros: bigint): string => new Date(Number(micros / 1000n)).toISOString();

// ── gated writes for states the service never creates ───────────────────────

/**
 * Plant or damage cursor rows under the REAL gate.
 *
 * A retained NULL-pointer row is the case §5 singles out, and §2 says this
 * slice never creates one — so the only honest way to reach that path is to
 * write the row here, holding the lock a writer would hold, in this run's own
 * disposable dataset.
 */
const GATED_WRITE_SOURCE = `
import json, sys
from datetime import datetime, timedelta

import lancedb
import pyarrow as pa
from arra_migrate.writer_gate import writer_gate

root = sys.argv[1]
with open(sys.argv[2], encoding="utf-8") as handle:
    plan = json.load(handle)

EPOCH = datetime(1970, 1, 1)

with writer_gate(root):
    db = lancedb.connect(root)
    for item in plan:
        table = db.open_table(item["table"])
        if item["op"] == "append":
            schema = table.schema
            rows = []
            for row in item["rows"]:
                built = {}
                for field in schema:
                    value = row.get(field.name)
                    if value is None:
                        built[field.name] = None
                    elif pa.types.is_timestamp(field.type):
                        built[field.name] = EPOCH + timedelta(microseconds=int(value))
                    elif pa.types.is_integer(field.type):
                        built[field.name] = int(value)
                    else:
                        built[field.name] = value
                rows.append(built)
            table.add(pa.Table.from_pylist(rows, schema=schema))
        elif item["op"] == "update":
            result = table.update(where=item["where"], values=item["values"])
            if getattr(result, "rows_updated", 1) == 0:
                raise SystemExit("update matched no rows: " + item["where"])
        else:
            raise SystemExit("unknown op: " + item["op"])
print(json.dumps({"ok": True}))
`;

type GatedWrite =
  | { op: "append"; table: string; rows: Record<string, unknown>[] }
  | { op: "update"; table: string; where: string; values: Record<string, unknown> };

async function gatedWrite(datasetRoot: string, items: GatedWrite[]): Promise<void> {
  const dir = await scratchDir("plant");
  const planPath = join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify(items), "utf8");
  const result = await runOwnedChild(PYTHON, ["-c", GATED_WRITE_SOURCE, datasetRoot, planPath]);
  if (result.code !== 0) throw new Error(`gated write failed (${result.code}): ${result.stderr.slice(0, 400)}`);
}

// ── locking a table tree, for the real SDK failures ─────────────────────────

async function lockTree(dir: string, mode: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await lockTree(join(dir, entry.name), mode);
  }
  await chmod(dir, mode);
}

/** Parent first, then descend: a 0o000 tree cannot be listed before it is opened. */
async function unlockTree(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await unlockTree(join(dir, entry.name));
  }
}

// ── a fixture with real messages to point at ────────────────────────────────

type Fixture = { root: string; messages: string[] };

const advanceStep = (pointer: string, expected: null | { last_read_message_id: string | null }): Step => ({
  facade: "context",
  method: "advanceReadCursor",
  request: {
    workspace_name: WORKSPACE,
    peer_name: PEER,
    session_name: SESSION,
    last_read_message_id: pointer,
    expected,
  },
});

const getStep = (): Step => ({
  facade: "context",
  method: "getReadCursor",
  request: { workspace_name: WORKSPACE, peer_name: PEER, session_name: SESSION },
});

/**
 * Registration and three real messages, published through the accepted context
 * facade so the cursor points at rows the service itself wrote.
 */
async function fixtureWithMessages(tag: string): Promise<Fixture> {
  const created = await createContextFixture([WORKSPACE, "beta-workspace"]);
  createdRoots.push({ path: created.datasetRoot, cleanup: created.cleanup });
  const root = created.datasetRoot;

  const messages = [id21("Msg"), id21("Msg"), id21("Msg")];
  const steps: Step[] = [
    {
      facade: "context",
      method: "registerPeer",
      request: { workspace_name: WORKSPACE, peer_id: id21("Peer"), name: PEER },
    },
    {
      facade: "context",
      method: "registerSession",
      request: { workspace_name: WORKSPACE, session_id: id21("Sess"), name: SESSION },
    },
    {
      facade: "context",
      method: "joinSession",
      request: { workspace_name: WORKSPACE, session_name: SESSION, peer_name: PEER },
    },
    {
      facade: "context",
      method: "appendMessages",
      request: {
        workspace_name: WORKSPACE,
        session_name: SESSION,
        items: messages.map((publicId, index) => ({
          public_id: publicId,
          message: { peer_name: PEER, role: "user", content: `message ${index}`, in_reply_to: null },
          source: null,
        })),
      },
    },
  ];
  const seeded = await run(plan(root, steps), `${tag}-seed`);
  for (let i = 0; i < steps.length; i++) expect(stepResult(seeded, i).ok).toBe(true);
  expect(okValue(seeded, 3).outcome).toBe("complete");
  expect(seeded.exitCode).toBe(0);
  return { root, messages };
}

// ── A. lost ACK on the APPEND path ──────────────────────────────────────────

recoveryTest("A1 a created cursor killed before its ACK is durable and replays with the RETAINED timestamp", async () => {
  const fixture = await fixtureWithMessages("a1");
  const pointer = fixture.messages[0]!;

  // No row exists yet, so `expected:null` is the absent-row prior state.
  const killed = await runAndKillAtPark(
    plan(fixture.root, [advanceStep(pointer, null)], { parkAt: { name: "after_write", n: 1 } }),
    "a1-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("parked");
  expect(killed.events.some((event) => event.event === "step_result")).toBe(false);

  // The complete five-field row is durable, with the microsecond value the
  // injected clock implies — authored here, not read back from the service.
  const durable = await cursorRows(fixture.root);
  expect(durable).toEqual([expectedCursorRow(pointer, BigInt(CLOCK_MS) * 1000n)]);

  // A deliberately later clock on the retry: any resample would show.
  const replay = await run(
    plan(fixture.root, [advanceStep(pointer, null), getStep()], {
      clockMs: Array.from({ length: 48 }, (_, i) => CLOCK_MS + 500_000 + i * 1000),
    }),
    "a1-replay",
  );
  const result = okValue(replay, 0);
  expect(result.outcome).toBe("already_satisfied");
  expect(result.row.last_read_message_id).toBe(pointer);
  expect(result.row.last_read_at).toBe(wireTimestamp(BigInt(CLOCK_MS) * 1000n));
  // §4.1: no clock, no mutation, no hook.
  expect(trace(replay)).toEqual([]);
  expect(await cursorRows(fixture.root)).toEqual([expectedCursorRow(pointer, BigInt(CLOCK_MS) * 1000n)]);
  expect(okValue(replay, 1).last_read_message_id).toBe(pointer);
});

recoveryTest("A2 a kill BEFORE the write leaves no row, and the retry creates one", async () => {
  const fixture = await fixtureWithMessages("a2");
  const pointer = fixture.messages[0]!;

  const killed = await runAndKillAtPark(
    plan(fixture.root, [advanceStep(pointer, null)], { parkAt: { name: "before_write", n: 1 } }),
    "a2-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("parked");
  expect(await cursorRows(fixture.root)).toEqual([]);

  const retry = await run(plan(fixture.root, [advanceStep(pointer, null)]), "a2-retry");
  const result = okValue(retry);
  expect(result.outcome).toBe("created");
  expect(trace(retry)).toEqual(MUTATION_TRIPLE);
  expect(await cursorRows(fixture.root)).toEqual([expectedCursorRow(pointer, BigInt(CLOCK_MS) * 1000n)]);
});

// ── B. lost ACK on the UPDATE path ──────────────────────────────────────────

recoveryTest("B1 an advanced cursor killed before its ACK is durable and replays as already_satisfied", async () => {
  const fixture = await fixtureWithMessages("b1");
  const [first, second] = fixture.messages as [string, string, string];

  const created = await run(plan(fixture.root, [advanceStep(first, null)]), "b1-create");
  expect(okValue(created).outcome).toBe("created");
  const priorRow = expectedCursorRow(first, BigInt(CLOCK_MS) * 1000n);
  expect(await cursorRows(fixture.root)).toEqual([priorRow]);

  // Advance to the second message, killed after the update lands.
  const advanceClock = CLOCK_MS + 60_000;
  const killed = await runAndKillAtPark(
    plan(fixture.root, [advanceStep(second, { last_read_message_id: first })], {
      parkAt: { name: "after_write", n: 1 },
      clockMs: Array.from({ length: 48 }, (_, i) => advanceClock + i * 1000),
    }),
    "b1-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("parked");
  const desiredRow = expectedCursorRow(second, BigInt(advanceClock) * 1000n);
  expect(await cursorRows(fixture.root)).toEqual([desiredRow]);

  // The retry carries the SAME expected value, which is now stale — §4.1 runs
  // before the expected comparison, so this is already_satisfied, not conflict.
  const replay = await run(
    plan(fixture.root, [advanceStep(second, { last_read_message_id: first })], {
      clockMs: Array.from({ length: 48 }, (_, i) => advanceClock + 500_000 + i * 1000),
    }),
    "b1-replay",
  );
  const result = okValue(replay);
  expect(result.outcome).toBe("already_satisfied");
  expect(result.row.last_read_at).toBe(wireTimestamp(BigInt(advanceClock) * 1000n));
  expect(trace(replay)).toEqual([]);
  expect(await cursorRows(fixture.root)).toEqual([desiredRow]);
});

recoveryTest("B2 an update killed BEFORE the write leaves the exact prior row, and the retry advances", async () => {
  const fixture = await fixtureWithMessages("b2");
  const [first, second] = fixture.messages as [string, string, string];
  await run(plan(fixture.root, [advanceStep(first, null)]), "b2-create");
  const priorRow = expectedCursorRow(first, BigInt(CLOCK_MS) * 1000n);

  const advanceClock = CLOCK_MS + 60_000;
  const killed = await runAndKillAtPark(
    plan(fixture.root, [advanceStep(second, { last_read_message_id: first })], {
      parkAt: { name: "before_write", n: 1 },
      clockMs: Array.from({ length: 48 }, (_, i) => advanceClock + i * 1000),
    }),
    "b2-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("parked");
  expect(await cursorRows(fixture.root)).toEqual([priorRow]);

  const retry = await run(
    plan(fixture.root, [advanceStep(second, { last_read_message_id: first })], {
      clockMs: Array.from({ length: 48 }, (_, i) => advanceClock + i * 1000),
    }),
    "b2-retry",
  );
  expect(okValue(retry).outcome).toBe("advanced");
  expect(trace(retry)).toEqual(MUTATION_TRIPLE);
  expect(await cursorRows(fixture.root)).toEqual([expectedCursorRow(second, BigInt(advanceClock) * 1000n)]);
});

// ── C. the retained NULL-pointer advance, as a composed statement ───────────

recoveryTest("C1 advancing a retained NULL-pointer row exercises the IS NULL guard, the cast and the readback", async () => {
  const fixture = await fixtureWithMessages("c1");
  const pointer = fixture.messages[0]!;

  // §2: this slice never creates a null-pointer row, so it is planted under
  // the real gate. Its timestamp is BELOW the advance clock so the §4.4
  // monotonic comparison passes on its own terms.
  const plantedMicros = BigInt(CLOCK_MS - 120_000) * 1000n;
  await gatedWrite(fixture.root, [
    {
      op: "append",
      table: "read_cursors",
      rows: [
        {
          workspace_name: WORKSPACE,
          peer_name: PEER,
          session_name: SESSION,
          last_read_message_id: null,
          last_read_at: plantedMicros.toString(),
        },
      ],
    },
  ]);
  expect(await cursorRows(fixture.root)).toEqual([expectedCursorRow(null, plantedMicros)]);

  const advanced = await run(plan(fixture.root, [advanceStep(pointer, { last_read_message_id: null })]), "c1");
  const result = okValue(advanced);
  expect(result.outcome).toBe("advanced");
  expect(result.row.last_read_message_id).toBe(pointer);
  expect(result.row.last_read_at).toBe(wireTimestamp(BigInt(CLOCK_MS) * 1000n));
  expect(trace(advanced)).toEqual(MUTATION_TRIPLE);
  // The composed statement really wrote: predicate guard, timestamp cast and
  // readback together, not three separately feasible primitives.
  expect(await cursorRows(fixture.root)).toEqual([expectedCursorRow(pointer, BigInt(CLOCK_MS) * 1000n)]);
});

recoveryTest("C2 a null-pointer advance killed before its ACK is durable and replays as already_satisfied", async () => {
  const fixture = await fixtureWithMessages("c2");
  const pointer = fixture.messages[1]!;
  const plantedMicros = BigInt(CLOCK_MS - 120_000) * 1000n;
  await gatedWrite(fixture.root, [
    {
      op: "append",
      table: "read_cursors",
      rows: [
        {
          workspace_name: WORKSPACE,
          peer_name: PEER,
          session_name: SESSION,
          last_read_message_id: null,
          last_read_at: plantedMicros.toString(),
        },
      ],
    },
  ]);

  const killed = await runAndKillAtPark(
    plan(fixture.root, [advanceStep(pointer, { last_read_message_id: null })], {
      parkAt: { name: "after_write", n: 1 },
    }),
    "c2-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("parked");
  expect(await cursorRows(fixture.root)).toEqual([expectedCursorRow(pointer, BigInt(CLOCK_MS) * 1000n)]);

  const replay = await run(
    plan(fixture.root, [advanceStep(pointer, { last_read_message_id: null })], {
      clockMs: Array.from({ length: 48 }, (_, i) => CLOCK_MS + 500_000 + i * 1000),
    }),
    "c2-replay",
  );
  expect(okValue(replay).outcome).toBe("already_satisfied");
  expect(trace(replay)).toEqual([]);
  expect(await cursorRows(fixture.root)).toEqual([expectedCursorRow(pointer, BigInt(CLOCK_MS) * 1000n)]);
});

// ── D. retry is CONDITIONAL, and that is measured rather than asserted ──────

recoveryTest("D1 a later legitimate advance turns an old retry into a conflict, not a convergence", async () => {
  const fixture = await fixtureWithMessages("d1");
  const [first, second, third] = fixture.messages as [string, string, string];
  await run(plan(fixture.root, [advanceStep(first, null)]), "d1-create");

  // The interrupted attempt: advance to the SECOND message, killed pre-write.
  const killed = await runAndKillAtPark(
    plan(fixture.root, [advanceStep(second, { last_read_message_id: first })], {
      parkAt: { name: "before_write", n: 1 },
    }),
    "d1-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("parked");

  // Meanwhile a legitimate advance reaches the THIRD message.
  const later = CLOCK_MS + 120_000;
  const moved = await run(
    plan(fixture.root, [advanceStep(third, { last_read_message_id: first })], {
      clockMs: Array.from({ length: 48 }, (_, i) => later + i * 1000),
    }),
    "d1-move",
  );
  expect(okValue(moved).outcome).toBe("advanced");
  const currentRow = expectedCursorRow(third, BigInt(later) * 1000n);

  // The old retry now asks to go BACKWARD. §4.2 classifies before the expected
  // comparison, so the reason is backward, and nothing is written.
  const retry = await run(
    plan(fixture.root, [advanceStep(second, { last_read_message_id: first })], {
      clockMs: Array.from({ length: 48 }, (_, i) => later + 500_000 + i * 1000),
    }),
    "d1-retry",
  );
  const result = okValue(retry);
  expect(result.outcome).toBe("conflict");
  expect(result.reason).toBe("backward");
  expect(result.row.last_read_message_id).toBe(third);
  // A conflict is a returned value: no hook, no mutation, and no poison — the
  // next call on the SAME owner still works.
  expect(trace(retry)).toEqual([]);
  expect(await cursorRows(fixture.root)).toEqual([currentRow]);
});

// ── E. safe pre-write versus post-attempt poison ────────────────────────────

recoveryTest("E1 a first before_write refusal leaves the owner usable and writes nothing", async () => {
  const fixture = await fixtureWithMessages("e1");
  const pointer = fixture.messages[0]!;

  const result = await run(
    plan(fixture.root, [advanceStep(pointer, null), advanceStep(pointer, null)], {
      throwAt: { name: "before_write", n: 1 },
    }),
    "e1",
  );
  expectThrown(errorOf(result, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "invalid_request",
    path: "",
  });
  // Nothing was attempted, so the SAME owner still serves the next request.
  const second = okValue(result, 1);
  expect(second.outcome).toBe("created");
  expect(await cursorRows(fixture.root)).toEqual([expectedCursorRow(pointer, BigInt(CLOCK_MS + 1000) * 1000n)]);
});

recoveryTest("E2 a failure AFTER the attempted write poisons the owner and leaves the row in place", async () => {
  const fixture = await fixtureWithMessages("e2");
  const pointer = fixture.messages[0]!;

  const result = await run(
    plan(fixture.root, [advanceStep(pointer, null), advanceStep(pointer, null)], {
      throwAt: { name: "after_write", n: 1 },
    }),
    "e2",
  );
  expectThrown(errorOf(result, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
  // The second request never runs on that owner: only the owner state
  // separates this case from E1, not the result shape.
  expectThrown(errorOf(result, 1), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
  // No rollback: the attempted row is durable.
  expect(await cursorRows(fixture.root)).toEqual([expectedCursorRow(pointer, BigInt(CLOCK_MS) * 1000n)]);

  // A fresh owner converges on it.
  const fresh = await run(plan(fixture.root, [advanceStep(pointer, null)]), "e2-fresh");
  expect(okValue(fresh).outcome).toBe("already_satisfied");
});

// ── F. real SDK failures, repaired BEFORE the second same-owner request ─────

for (const fault of [
  { label: "the append", park: { name: "before_write" as const, n: 1 }, mode: 0o500, planted: false },
  { label: "the update", park: { name: "before_write" as const, n: 1 }, mode: 0o500, planted: true },
  // Removing read as well makes the post-write verification itself impossible.
  { label: "the readback", park: { name: "after_write" as const, n: 1 }, mode: 0o000, planted: false },
] as const) {
  recoveryTest(`F1 a real SDK failure at ${fault.label} poisons, and a REPAIRED table does not un-poison`, async () => {
    const fixture = await fixtureWithMessages(`f1-${fault.label.replace(/\s/g, "-")}`);
    const table = join(fixture.root, "read_cursors.lance");
    const pointer = fixture.messages[1]!;
    const expectedPrior = fault.planted ? expectedCursorRow(fixture.messages[0]!, BigInt(CLOCK_MS) * 1000n) : null;
    if (fault.planted) {
      const created = await run(plan(fixture.root, [advanceStep(fixture.messages[0]!, null)]), "f1-prior");
      expect(okValue(created).outcome).toBe("created");
    }
    const request = fault.planted
      ? advanceStep(pointer, { last_read_message_id: fixture.messages[0]! })
      : advanceStep(pointer, null);

    // Commanded end to end so the repair is provably between the two requests.
    const child = await launch(
      plan(fixture.root, [request, request], {
        parkAt: fault.park,
        emitPark: "after_response_emission",
        resumeOnStdin: true,
        clockMs: Array.from({ length: 48 }, (_, i) => CLOCK_MS + 120_000 + i * 1000),
      }),
      "f1",
    );
    const events: ChildEvent[] = [];
    const observed: string[] = [];
    const until = async (kind: string): Promise<ChildEvent> => {
      for (;;) {
        const event = await child.nextEvent();
        events.push(event);
        if (event.event !== "boundary") observed.push(event.event);
        if (event.event === kind) return event;
      }
    };

    let exitCode: number;
    try {
      await until("parked");
      await lockTree(table, fault.mode);
      child.resume();
      await until("step_result");
      await until("post_emit");

      // REPAIRED here, with the child parked and provably not yet inside its
      // second request. Asserted, not assumed.
      await unlockTree(table);
      await access(table, constants.W_OK);
      observed.push("repaired");

      child.resume();
      child.endInput();
      await until("done");
      exitCode = await child.waitForExit();
    } finally {
      await unlockTree(table).catch(() => undefined);
      await child.killAndReap();
    }

    const result: Run = { events, exitCode, stderr: child.stderr() };
    expect(exitCode).toBe(0); // measured, not constructed
    expect(observed).toEqual(["ready", "parked", "step_result", "post_emit", "repaired", "step_result", "done"]);

    expectThrown(errorOf(result, 0), {
      name: "PublicationError",
      version: PUBLICATION_ENVELOPE,
      code: "recovery_required",
      path: "",
    });
    // The table is writable again and the SAME owner is still refused.
    expectThrown(errorOf(result, 1), {
      name: "PublicationError",
      version: PUBLICATION_ENVELOPE,
      code: "recovery_required",
      path: "",
    });

    // A fresh owner proves the dataset is usable and converges.
    const fresh = await run(
      plan(fixture.root, [request], {
        clockMs: Array.from({ length: 48 }, (_, i) => CLOCK_MS + 240_000 + i * 1000),
      }),
      "f1-fresh",
    );
    const recovered = okValue(fresh);
    expect(["created", "advanced", "already_satisfied"]).toContain(recovered.outcome);
    expect(recovered.row.last_read_message_id).toBe(pointer);
    if (expectedPrior !== null) {
      // Whatever happened, the prior pointer is not what remains.
      expect((await cursorRows(fixture.root))[0]!.last_read_message_id).not.toBe(expectedPrior.last_read_message_id);
    }
  });
}

// ── G. corrupt retained state is integrity_failure ──────────────────────────

recoveryTest("G1 a duplicate retained cursor key is integrity_failure and nothing is written", async () => {
  const fixture = await fixtureWithMessages("g1");
  const pointer = fixture.messages[0]!;
  const micros = BigInt(CLOCK_MS - 120_000) * 1000n;
  const row = {
    workspace_name: WORKSPACE,
    peer_name: PEER,
    session_name: SESSION,
    last_read_message_id: null,
    last_read_at: micros.toString(),
  };
  // Two rows at one logical key: §3 forbids picking or repairing either.
  await gatedWrite(fixture.root, [{ op: "append", table: "read_cursors", rows: [row, row] }]);
  const before = await cursorRows(fixture.root);
  expect(before.length).toBe(2);

  const result = await run(plan(fixture.root, [advanceStep(pointer, { last_read_message_id: null }), getStep()]), "g1");
  expectThrown(errorOf(result, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "integrity_failure",
    path: "",
  });
  // The read side refuses identically, and nothing was written or repaired.
  expectThrown(errorOf(result, 1), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "integrity_failure",
    path: "",
  });
  expect(await cursorRows(fixture.root)).toEqual(before);
});

// ── I. post-readback faults, by instrumented in-process interleave ─────────
//
// CORRECTION: an earlier version of this file claimed the post-readback case
// was unreachable without bypassing the gate. That was wrong. The gated child
// ALREADY holds the real descriptor, so it can open a raw SDK connection to
// its own disposable root inside that same process and plant the fault between
// the service's write and its readback. No second writer, no fake descriptor,
// no product adapter or export.
//
// What these two cases are: evidence of how the service CLASSIFIES state it
// finds at readback. What they are not: a cooperative writer, a concurrency
// test, or evidence about real SDK failures — F1 owns that and is untouched.
// The planted rows are authored here, never rebuilt from what the service
// just wrote.

recoveryTest("I1 a duplicate row planted before the readback is integrity_failure and poisons the owner", async () => {
  const fixture = await fixtureWithMessages("i1");
  const pointer = fixture.messages[0]!;
  const micros = BigInt(CLOCK_MS) * 1000n;

  const result = await run(
    plan(fixture.root, [advanceStep(pointer, null), advanceStep(pointer, null)], {
      injectAt: { name: "after_write", n: 1 },
      injection: {
        kind: "duplicate_cursor",
        row: {
          workspace_name: WORKSPACE,
          peer_name: PEER,
          session_name: SESSION,
          last_read_message_id: pointer,
          last_read_at_micros: micros.toString(10),
        },
      },
    }),
    "i1",
  );
  // The COMMANDED occurrence fired, not merely some injection somewhere.
  expect(injectedEvent(result)).toEqual({ event: "injected", name: "after_write", n: 1, step: 0 });
  // Ordered evidence: the fault lands after the write boundary and the
  // readback never completes, so no after_readback boundary exists at all.
  expect(sequenceThroughFirstResult(result)).toEqual([
    "ready",
    "boundary:before_write#1",
    "boundary:after_write#1",
    "injected:after_write#1",
    "step_result:0",
  ]);
  expect(trace(result)).not.toContain("after_readback#1");

  // §5: a duplicate found by the readback keeps its stored-state class AND
  // poisons, because it follows an attempted write.
  expectThrown(errorOf(result, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "integrity_failure",
    path: "",
  });
  expectThrown(errorOf(result, 1), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
  // No rollback, no repair — and the exact two authored rows are what remain,
  // which a length check would not have shown.
  const remaining = await cursorRows(fixture.root);
  expect(remaining).toEqual([expectedCursorRow(pointer, micros), expectedCursorRow(pointer, micros)]);
});

recoveryTest("I2 a well-formed UNEXPECTED timestamp before the readback is recovery_required and poisons", async () => {
  const fixture = await fixtureWithMessages("i2");
  const pointer = fixture.messages[0]!;
  // Valid in every structural sense — millisecond-aligned, in range, non-null —
  // and simply not the value this operation wrote. That is the difference
  // between §5's two post-readback classes.
  const unexpectedMicros = BigInt(CLOCK_MS + 7_000) * 1000n;

  const result = await run(
    plan(fixture.root, [advanceStep(pointer, null), advanceStep(pointer, null)], {
      injectAt: { name: "after_write", n: 1 },
      injection: {
        kind: "unexpected_timestamp",
        micros: unexpectedMicros.toString(10),
        where: `workspace_name = '${WORKSPACE}' AND peer_name = '${PEER}' AND session_name = '${SESSION}'`,
      },
    }),
    "i2",
  );
  expect(injectedEvent(result)).toEqual({ event: "injected", name: "after_write", n: 1, step: 0 });
  expect(sequenceThroughFirstResult(result)).toEqual([
    "ready",
    "boundary:before_write#1",
    "boundary:after_write#1",
    "injected:after_write#1",
    "step_result:0",
  ]);
  expect(trace(result)).not.toContain("after_readback#1");

  expectThrown(errorOf(result, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
  expectThrown(errorOf(result, 1), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
  // The planted value stands: nothing is rolled back or repaired.
  expect(await cursorRows(fixture.root)).toEqual([expectedCursorRow(pointer, unexpectedMicros)]);
});

// ── H. the parent's own bounds are refutable ────────────────────────────────

recoveryTest("H1 the parent deadline fires: a silent child is killed and reaped", async () => {
  const created = await createContextFixture([WORKSPACE]);
  createdRoots.push({ path: created.datasetRoot, cleanup: created.cleanup });
  const child = await launch(plan(created.datasetRoot, []), "h1", SILENT_CHILD);
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
  // Configured at 1.5s: asserted to have waited about that long, and to have
  // returned far inside the runner timeout. A strict upper bound would be a
  // flaky claim under scheduling jitter.
  expect(elapsedMs).toBeGreaterThan(configuredMs * 0.9);
  expect(elapsedMs).toBeLessThan(30_000);
  await child.killAndReap(5_000);
  expect(await cursorRows(created.datasetRoot)).toEqual([]);
});
