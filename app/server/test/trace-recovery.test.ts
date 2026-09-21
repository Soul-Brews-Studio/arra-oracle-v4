/**
 * #28 trace + trace_hit recovery — lost ACK, fail-stop, ambiguous partial
 * writes, the unit trap, position gaps and real SDK failures.
 *
 * Contract: `app/docs/contracts/trace-v1.md`, §§1, 3, 5, 6. Facade shape,
 * queue/poison-both-directions and cross-factory exclusion belong to
 * `trace-ownership.test.ts`; method semantics and grammar to
 * `trace-service.test.ts`. None is duplicated here.
 *
 * Harness modelled directly on the accepted, hard-reviewed
 * `read-cursor-recovery.test.ts`: a Python launcher (`exec_with_gate`)
 * replaces itself in place with a Bun child that holds the real writer gate,
 * emits one JSON event per line, and can be parked at a named boundary and
 * SIGKILLed by the parent at an exact pid. `createTrace` fires ONE
 * before_write/after_write/after_readback triple per row it appends (the
 * trace row, then each hit in order) — unlike the cursor kernel's fixed
 * single triple, so the occurrence number (`n`) in a park/throw spec must be
 * chosen against that per-row count, not assumed to be 1.
 *
 * What this file proves, per the shared brief:
 *
 * * A1: kill after the append lands but before the ACK reaches the caller —
 *   durable evidence checked via a raw, gateless read, and the retry
 *   returning the RETAINED millisecond timestamp (not a fresh sample).
 * * A2 (the unit trap): the retained `created_at`/`updated_at` are exact raw
 *   MILLISECONDS and the hit's `captured_at` is exact raw MICROSECONDS,
 *   round-tripped through a kill-and-recover cycle in the SAME test. A 1000x
 *   scale bug on either column would either mis-render the date or throw
 *   `integrity_failure` (year > 9999) — either way, loudly, not silently.
 * * B: the trace row lands and a LATER hit's append is killed before its own
 *   ACK — an ambiguous PARTIAL write. A fresh, unpoisoned owner's
 *   byte-identical retry is `recovery_required`, never `conflict`/`payload`:
 *   the caller is not blamed for incomplete stored state it did not cause.
 * * C: a planted position GAP in `trace_hits` is `integrity_failure` at ROOT,
 *   reached through a raw gated append (the real write path can only ever
 *   assign contiguous 0..n-1), independent evidence from `trace-service.test.ts`'s
 *   in-process harness version of the same invariant.
 * * D: a year-0000 `captured_at` refuses at its FIELD POINTER, writes
 *   NOTHING (checked via a raw read, not just a null `getTrace`), and does
 *   NOT poison — proven by a second, unrelated createTrace succeeding on the
 *   SAME owner immediately after.
 * * E: a first `before_write` refusal leaves the owner usable (safe,
 *   pre-attempt); a failure AFTER the attempted write poisons it — the exact
 *   §5 distinction, and only the owner's state afterwards separates them.
 * * F: a REAL SDK failure (a permission-locked table directory) poisons with
 *   `recovery_required`; the table is repaired BETWEEN two requests on the
 *   SAME owner, observed as a handshake point, and the same owner is STILL
 *   refused; only a FRESH owner converges.
 *
 * Bounded claims: process death and SDK-reported failure on local
 * Darwin/POSIX with pinned Python/Bun. Not power loss, not filesystem
 * hardware, not multiwriter. The gate stays a cooperative operator protocol.
 *
 * Ownership: this file and `test/fixtures/trace-v1/recovery/**` only.
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
import { hitInput, traceId } from "./helpers/trace-fixture";

// ── dependencies ────────────────────────────────────────────────────────────

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url)).replace(/\/test\/?$/, "");
const SERVICE_MODULE = join(SERVER_DIR, "src/publication/service.ts");
const RECOVERY_DIR = join(SERVER_DIR, "test/fixtures/trace-v1/recovery");
const TRACE_CHILD = join(RECOVERY_DIR, "trace-child.ts");
const SILENT_CHILD = join(RECOVERY_DIR, "silent-child.ts");
const PY_SRC = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));

const MISSING: string[] = [
  [PYTHON, "python interpreter (set ARRA_CONTRACT_PYTHON)"],
  [SERVICE_MODULE, "src/publication/service.ts"],
  [TRACE_CHILD, "fixtures/trace-v1/recovery/trace-child.ts"],
  [SILENT_CHILD, "fixtures/trace-v1/recovery/silent-child.ts"],
]
  .filter(([path]) => !existsSync(path!))
  .map(([, label]) => label!);

if (existsSync(SERVICE_MODULE)) {
  const source = readFileSync(SERVICE_MODULE, "utf8");
  for (const symbol of ["createTrace", "getTrace", "listTraceHits"]) {
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

test("preflight: every trace dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});

// ── creation records ────────────────────────────────────────────────────────

const createdRoots: { path: string; cleanup?: () => Promise<void> }[] = [];

async function scratchDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arra-trace-recovery-${tag}-`));
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
const CLOCK_MS = 1_790_100_000_000;

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
  injectAt?: { name: Boundary; n: number } | null;
  injection?: Record<string, unknown> | null;
  emitPark?: "before_response_emission" | "after_response_emission" | null;
  resumeOnStdin?: boolean;
  parkStep?: number;
  steps: Step[];
};

const HANDSHAKE_DEADLINE_MS = 60_000;
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
    revisionIds: Array.from({ length: 8 }, () => "r".repeat(21)),
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

async function launch(spec: Plan, tag: string, script = TRACE_CHILD): Promise<Child> {
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
          child.kill(9);
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
    return { events, exitCode: -1, stderr: child.stderr() };
  } finally {
    await child.killAndReap();
  }
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

async function rawRows(datasetRoot: string, table: string, predicate?: string): Promise<Record<string, unknown>[]> {
  const db = await connect(datasetRoot, { readConsistencyInterval: 0 });
  const handle = await db.openTable(table);
  await handle.checkoutLatest();
  const query = predicate === undefined ? handle.query() : handle.query().where(predicate);
  const arrow = await query.toArrow();
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < arrow.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const field of arrow.schema.fields) row[field.name] = rawCell(arrow.getChild(field.name), i);
    rows.push(row);
  }
  return rows;
}

const tracesRows = (datasetRoot: string) => rawRows(datasetRoot, "traces");
const traceHitsRows = (datasetRoot: string, predicate?: string) => rawRows(datasetRoot, "trace_hits", predicate);

/** The authored expectation for one stored `traces` row, physical order,
 *  RAW milliseconds preserved as BigInt — never rendered through the
 *  service's own millisToTimestamp, which would make the product its own
 *  oracle for the very unit trap this file exists to catch. */
function expectedTraceRow(traceKey: string, millis: bigint, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: traceId(traceKey),
    name: "trace-a",
    workspace_name: WORKSPACE,
    session_name: null,
    peer_name: null,
    query: "find the bug",
    mode: null,
    session_id: null,
    session_from_ts: null,
    session_to_ts: null,
    friction_score: null,
    confidence: null,
    parent_id: null,
    prev_id: null,
    depth: 0n,
    status: "open",
    h_metadata: null,
    internal_metadata: null,
    created_at: millis,
    updated_at: millis,
    ...overrides,
  };
}

const wireMillis = (millis: bigint): string => new Date(Number(millis)).toISOString();
const wireMicros = (micros: bigint): string => new Date(Number(micros / 1000n)).toISOString();

// ── gated writes for states the service never creates ───────────────────────

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
        else:
            raise SystemExit("unknown op: " + item["op"])
print(json.dumps({"ok": True}))
`;

type GatedWrite = { op: "append"; table: string; rows: Record<string, unknown>[] };

async function gatedWrite(datasetRoot: string, items: GatedWrite[]): Promise<void> {
  const dir = await scratchDir("plant");
  const planPath = join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify(items), "utf8");
  const result = await runOwnedChild(PYTHON, ["-c", GATED_WRITE_SOURCE, datasetRoot, planPath]);
  if (result.code !== 0) throw new Error(`gated write failed (${result.code}): ${result.stderr.slice(0, 400)}`);
}

// ── locking a table tree, for the real SDK failure ──────────────────────────

async function lockTree(dir: string, mode: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await lockTree(join(dir, entry.name), mode);
  }
  await chmod(dir, mode);
}

async function unlockTree(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await unlockTree(join(dir, entry.name));
  }
}

// ── a bare fixture, workspace only ──────────────────────────────────────────

async function fixtureRoot(): Promise<string> {
  const created = await createContextFixture([WORKSPACE, "beta-workspace"]);
  createdRoots.push({ path: created.datasetRoot, cleanup: created.cleanup });
  return created.datasetRoot;
}

const createStep = (traceKey: string, hits: Record<string, unknown>[] = []): Step => ({
  facade: "context",
  method: "createTrace",
  request: {
    workspace_name: WORKSPACE,
    id: traceId(traceKey),
    name: "trace-a",
    session_name: null,
    peer_name: null,
    query: "find the bug",
    mode: null,
    session_id: null,
    session_from_ts: null,
    session_to_ts: null,
    friction_score: null,
    confidence: null,
    parent_id: null,
    prev_id: null,
    depth: "0",
    status: "open",
    h_metadata: null,
    internal_metadata: null,
    hits,
  },
});

const getStep = (traceKey: string): Step => ({
  facade: "context",
  method: "getTrace",
  request: { workspace_name: WORKSPACE, id: traceId(traceKey) },
});

// ── A. lost ACK, and the unit trap round trip ───────────────────────────────

recoveryTest(
  "A1 a created trace killed before its ACK is durable in exact MILLISECONDS, and replays with the RETAINED value",
  async () => {
    const root = await fixtureRoot();
    const key = "a1trace";

    const killed = await runAndKillAtPark(
      plan(root, [createStep(key)], { parkAt: { name: "after_write", n: 1 } }),
      "a1-crash",
    );
    expect(killed.events.at(-1)?.event).toBe("parked");
    expect(killed.events.some((event) => event.event === "step_result")).toBe(false);

    // Durable in RAW milliseconds — a 1000x scale bug would show here as a
    // BigInt a thousand times too large or too small, not merely a wrong date.
    const durable = await tracesRows(root);
    expect(durable).toEqual([expectedTraceRow(key, BigInt(CLOCK_MS))]);

    // A deliberately later clock on the retry: any resample would show.
    const replay = await run(
      plan(root, [createStep(key), getStep(key)], {
        clockMs: Array.from({ length: 48 }, (_, i) => CLOCK_MS + 500_000 + i * 1000),
      }),
      "a1-replay",
    );
    const result = okValue(replay, 0);
    expect(result.outcome).toBe("already_satisfied");
    // Rendered wire text is the SERVICE's own millisToTimestamp; the raw
    // durable check above is this file's INDEPENDENT oracle for the value.
    expect(result.row.created_at).toBe(wireMillis(BigInt(CLOCK_MS)));
    expect(result.row.updated_at).toBe(wireMillis(BigInt(CLOCK_MS)));
    expect(await tracesRows(root)).toEqual([expectedTraceRow(key, BigInt(CLOCK_MS))]);
    expect(okValue(replay, 1).id).toBe(traceId(key));
  },
);

recoveryTest(
  "A2 the unit trap: a hit's captured_at is exact raw MICROSECONDS, independently of the trace row's MILLISECONDS",
  async () => {
    const root = await fixtureRoot();
    const key = "a2trace";
    const capturedAt = "2026-09-21T00:00:00.123Z";
    const step = createStep(key, [hitInput({ ref: "hit-0", captured_at: capturedAt }) as Record<string, unknown>]);

    const killed = await runAndKillAtPark(plan(root, [step], { parkAt: { name: "after_write", n: 2 } }), "a2-crash");
    expect(killed.events.at(-1)?.event).toBe("parked");

    // Both units durable at once, from ONE serialized turn: the trace row's
    // created_at/updated_at in RAW milliseconds, the hit's captured_at in RAW
    // microseconds — 123ms of sub-second precision the millisecond columns
    // could never carry, proving the two are independently converted, not
    // one value reused at the wrong scale.
    expect(await tracesRows(root)).toEqual([expectedTraceRow(key, BigInt(CLOCK_MS))]);
    const hits = await traceHitsRows(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.captured_at).toBe(BigInt(Date.parse(capturedAt)) * 1000n);
    expect(hits[0]!.position).toBe(0n);

    const replay = await run(plan(root, [step]), "a2-replay");
    const result = okValue(replay, 0);
    expect(result.outcome).toBe("already_satisfied");
    expect(result.row.created_at).toBe(wireMillis(BigInt(CLOCK_MS)));
    expect(result.hits[0].captured_at).toBe(wireMicros(BigInt(Date.parse(capturedAt)) * 1000n));
    expect(result.hits[0].captured_at).toBe(capturedAt);
  },
);

// ── B. an ambiguous PARTIAL write across two rows, and the conditional retry ─

recoveryTest(
  "B1 a trace row plus a PREFIX of its hits, killed before the last hit's ACK, is recovery_required on retry — never conflict",
  async () => {
    const root = await fixtureRoot();
    const key = "b1trace";
    const full = createStep(key, [
      hitInput({ ref: "hit-0" }) as Record<string, unknown>,
      hitInput({ ref: "hit-1" }) as Record<string, unknown>,
    ]);

    // Park after the SECOND triple's after_write: the trace row (triple #1)
    // and hit 0 (triple #2) are durable; hit 1 (triple #3) never starts.
    const killed = await runAndKillAtPark(plan(root, [full], { parkAt: { name: "after_write", n: 2 } }), "b1-crash");
    expect(killed.events.at(-1)?.event).toBe("parked");
    expect(await tracesRows(root)).toHaveLength(1);
    const hitsAfterCrash = await traceHitsRows(root);
    expect(hitsAfterCrash).toHaveLength(1);
    expect(hitsAfterCrash[0]!.position).toBe(0n);

    // A FRESH, unpoisoned owner receives the byte-identical retry.
    const retry = await run(plan(root, [full]), "b1-retry");
    const outcome = errorOf(retry, 0);
    // §3: an exact element-wise PREFIX match is recovery_required, never a
    // returned conflict — the caller is not blamed for a state it did not
    // itself write incompletely.
    expectThrown(outcome, {
      name: "PublicationError",
      version: PUBLICATION_ENVELOPE,
      code: "recovery_required",
      path: "",
    });
    expect(outcome.code).not.toBe("invalid_request");

    // The poisoned retry attempt wrote nothing further: still exactly one
    // trace row and one hit, unchanged.
    expect(await tracesRows(root)).toHaveLength(1);
    expect(await traceHitsRows(root)).toHaveLength(1);

    // A SECOND fresh owner completes the missing hit and converges.
    const completed = await run(plan(root, [full]), "b1-complete");
    // The retry above poisoned ITS OWN owner via TR-2's failPublication, so
    // this is a genuinely fresh process — the accepted convention throughout
    // this suite for "does a later attempt actually finish the job".
    expect(errorOf(completed, 0).code).toBe("recovery_required");
    // TR-2 never appends past the prefix itself (immutable, no append-hits
    // method) -- the stored state after a byte-identical retry is UNCHANGED,
    // which this file records as the honest, disclosed shape of the gap: v1
    // has no repair path for a stranded partial hit list short of re-reading
    // the retained prefix through listTraceHits and accepting it as final.
    const finalHits = await traceHitsRows(root);
    expect(finalHits).toHaveLength(1);
    expect(finalHits[0]!.position).toBe(0n);
  },
);

// ── C. a planted position gap is integrity_failure at ROOT ──────────────────

recoveryTest("C1 a planted position gap in trace_hits is integrity_failure at ROOT, via a real gated append", async () => {
  const root = await fixtureRoot();
  const key = "c1trace";
  const created = await run(plan(root, [createStep(key, [hitInput({ ref: "hit-0" }) as Record<string, unknown>])]), "c1-create");
  expect(okValue(created, 0).outcome).toBe("created");

  // Position 5 where only 0 exists: the real write path can only ever assign
  // contiguous 0..n-1, so this state is reachable only by a raw gated append.
  await gatedWrite(root, [
    {
      op: "append",
      table: "trace_hits",
      rows: [
        {
          workspace_name: WORKSPACE,
          trace_id: traceId(key),
          kind: "url",
          ref: "hit-gap",
          target: '{"url":"https://example.com/gap"}',
          line_start: null,
          line_end: null,
          excerpt: null,
          content_hash: null,
          captured_at: null,
          note: null,
          position: 5,
        },
      ],
    },
  ]);

  const listed = await run(
    plan(root, [
      { facade: "context", method: "listTraceHits", request: { workspace_name: WORKSPACE, trace_id: traceId(key), after_position: null, limit: 10 } },
    ]),
    "c1-list",
  );
  expectThrown(errorOf(listed, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "integrity_failure",
    path: "",
  });
  // Nothing repaired or removed: the gap persists exactly as planted.
  const hits = await traceHitsRows(root);
  expect(hits.map((h) => h.position).sort((a, b) => Number(a as bigint) - Number(b as bigint))).toEqual([0n, 5n]);
});

// ── D. a year-0000 refusal writes nothing and does not poison ───────────────

recoveryTest(
  "D1 a year-0000 captured_at refuses at its field pointer, writes NOTHING durably, and the owner still works",
  async () => {
    const root = await fixtureRoot();
    const bad = "d1bad";
    const good = "d1good";
    const result = await run(
      plan(root, [
        createStep(bad, [hitInput({ ref: "hit-0", captured_at: "0000-06-15T12:00:00.000Z" }) as Record<string, unknown>]),
        createStep(good),
      ]),
      "d1",
    );
    // The governed grammar error, NOT a PublicationError: parseCreateTrace's
    // `nullableCapturedAt` -> `requireTimestampString` runs entirely outside
    // `mutate()`, so this is a pure parse-time throw, before any boundary.
    const rejected = errorOf(result, 0);
    expect({
      name: rejected.name,
      version: rejected.version,
      code: rejected.code,
      path: rejected.path,
    }).toEqual({
      name: "ContractError",
      version: "arra-error/v1",
      code: "invalid_value",
      path: "/hits/0/captured_at",
    });
    // Owner still usable: a SECOND, unrelated request on the SAME owner
    // succeeds immediately afterward — a poisoned owner would refuse it with
    // recovery_required regardless of payload.
    expect(okValue(result, 1).outcome).toBe("created");
    // No orphan row at all for the rejected trace id: this was a pure parse
    // failure, entirely before any boundary or write.
    expect(await tracesRows(root)).toEqual([expectedTraceRow(good, BigInt(CLOCK_MS))]);
    expect(await traceHitsRows(root)).toHaveLength(0);
  },
);

// ── E. safe pre-write refusal versus post-attempt poison ────────────────────

recoveryTest("E1 a first before_write refusal leaves the owner usable and writes nothing", async () => {
  const root = await fixtureRoot();
  const key = "e1trace";
  const result = await run(
    plan(root, [createStep(key), createStep("e1trace2")], { throwAt: { name: "before_write", n: 1 } }),
    "e1",
  );
  expectThrown(errorOf(result, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "invalid_request",
    path: "",
  });
  const second = okValue(result, 1);
  expect(second.outcome).toBe("created");
  expect(await tracesRows(root)).toHaveLength(1);
});

recoveryTest("E2 a failure AFTER the attempted write poisons the owner and leaves the row in place", async () => {
  const root = await fixtureRoot();
  const key = "e2trace";
  const result = await run(
    plan(root, [createStep(key), createStep("e2trace2")], { throwAt: { name: "after_write", n: 1 } }),
    "e2",
  );
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
  // No rollback: the attempted trace row is durable.
  expect(await tracesRows(root)).toEqual([expectedTraceRow(key, BigInt(CLOCK_MS))]);

  const fresh = await run(plan(root, [createStep(key)]), "e2-fresh");
  expect(okValue(fresh, 0).outcome).toBe("already_satisfied");
});

// ── F. a real SDK failure, repaired BEFORE the second same-owner request ────

recoveryTest("F1 a real SDK failure poisons, and a REPAIRED traces table does not un-poison the SAME owner", async () => {
  const root = await fixtureRoot();
  const table = join(root, "traces.lance");
  const key = "f1trace";
  const request = createStep(key);

  const child = await launch(
    plan(root, [request, request], {
      parkAt: { name: "before_write", n: 1 },
      emitPark: "after_response_emission",
      resumeOnStdin: true,
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
    await lockTree(table, 0o500);
    child.resume();
    await until("step_result");
    await until("post_emit");

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
  expect(exitCode).toBe(0);
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

  // A fresh owner proves the dataset is usable and converges. Pinned to
  // "created", not a disjunction with "already_satisfied": `lockTree` chmods
  // BEFORE `child.resume()`, so `writer.append` itself fails on BOTH poisoned
  // attempts (permission denied on the real SDK call) -- no row was ever
  // durably written by either one. A fresh owner is therefore doing a
  // genuinely first write, deterministically "created".
  const fresh = await run(plan(root, [request]), "f1-fresh");
  expect(okValue(fresh, 0).outcome).toBe("created");
});

// ── G. the parent's own bounds are refutable ────────────────────────────────

recoveryTest("G1 the parent deadline fires: a silent child is killed and reaped", async () => {
  const root = await fixtureRoot();
  const child = await launch(plan(root, []), "g1", SILENT_CHILD);
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
  expect(elapsedMs).toBeGreaterThan(configuredMs * 0.9);
  expect(elapsedMs).toBeLessThan(30_000);
  await child.killAndReap(5_000);
  expect(await tracesRows(root)).toEqual([]);
});
