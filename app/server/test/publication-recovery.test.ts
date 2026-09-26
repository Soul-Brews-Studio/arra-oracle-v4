/**
 * #26 publication recovery — real process death, replay, and fail-stop.
 *
 * Contract: `app/docs/contracts/revision-publication-v1.md`
 * SHA256 387272dc8655319f877ef2bb4926caf0127c3712373b1309084e2d00172a9f9c
 * (supersedes 257ca098…; the amendment added the §9 deterministic fault-test
 * seam this file drives).
 *
 * What this file proves, and what it deliberately does not:
 *
 * * Every owner is a REAL separate process holding the real writer gate,
 *   launched through `writer_gate.exec_with_gate`, killed with SIGKILL on its
 *   exact owned PID and reaped. Recovery is always performed by a FRESH owned
 *   process — never by a surviving handle, a mocked connection or an in-test
 *   re-entry, because a same-handle "restart" proves nothing about what
 *   survived on disk.
 * * Boundaries are COMMANDED, not timed. The child parks inside the §9
 *   `onBoundary` callback and tells its parent, by a handshake line, that it
 *   has arrived; only then does the parent kill it. There is no polling race
 *   and no sleep anywhere in this file. The two response-emission boundaries
 *   live in this harness AFTER the service call returns, exactly as §9
 *   requires — they are not a fabricated service transport.
 * * Assertions are about PERSISTED ROWS and ACCEPTED ANCESTRY, not about
 *   thrown errors alone. Every case reads the durable tables directly (a
 *   read-only connection, which needs no gate) and also reads through the
 *   scoped reader service, because "invisible to the accepted view but present
 *   on disk" is precisely the orphan state the contract cares about.
 * * Bounded claim, stated plainly: this covers PROCESS DEATH. SDK readback is
 *   not power-loss or filesystem-hardware proof, and the gate is a cooperative
 *   local operator protocol, not a multiwriter CAS (§3, §7, §10).
 *
 * Ownership: this file is owned by v4-recovery. Writer-vs-writer contention,
 * alias roots, in-process second owners and unwrapped-launch refusal belong to
 * `publication-ownership.test.ts`; reference/policy validation, ancestry
 * limits and timestamp precision round trips belong to
 * `publication-service.test.ts`. Nothing here reaches into those.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@lancedb/lancedb";
import {
  CHILD_DEADLINE_MS,
  PYTHON,
  createFixture as createSeededFixture,
  encodeRequest,
  idSource,
  revisionEnvelope,
  runOwnedChild,
  type SeededWorkspace,
} from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

// ── paths and pending dependencies ──────────────────────────────────────────

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
/** §11 / seams: service.ts is the ONLY publication entrypoint. */
const SERVICE_MODULE = join(SERVER_DIR, "src/publication/service.ts");
const PY_SRC = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));
const PY_TESTS = fileURLToPath(new URL("../../migrate-py/tests", import.meta.url));
const WRITER_GATE = join(PY_SRC, "arra_migrate/writer_gate.py");
const FIXTURE_CREATOR = join(PY_TESTS, "export_publication_fixture.py");

/**
 * Dependencies owned by other workers in this slice.
 *
 * While any of these is absent the recovery cases cannot run at all: this file
 * may not create a target dataset itself, because §3 requires every writer of
 * a target dataset to take the gate before a writable connect and §11 names
 * `export_publication_fixture.py` as the only new fixture creator. A missing
 * module proves absence, not behavioural red — so the cases below are skipped
 * with the reason in their name, and the preflight test FAILS loudly so a skip
 * can never be read as acceptance.
 */
const MISSING: string[] = [
  [PYTHON, "python interpreter (set ARRA_CONTRACT_PYTHON)"],
  [WRITER_GATE, "arra_migrate.writer_gate"],
  [FIXTURE_CREATOR, "export_publication_fixture.py (v4-fixtures)"],
  [SERVICE_MODULE, "src/publication/service.ts"],
]
  .filter(([path]) => !existsSync(path!))
  .map(([, label]) => label!);

const PENDING = MISSING.length > 0;
const reason = PENDING ? ` [PENDING: ${MISSING.join(", ")}]` : "";

/**
 * Wall-clock budget per case.
 *
 * Every case creates a fixture dataset and runs two or three REAL gated
 * processes, so the default 5s would time out on the machinery rather than on
 * anything under test. Each child still carries its own parent-enforced
 * deadline; this is only the outer bound on the case as a whole.
 */
const CASE_TIMEOUT_MS = testTimeout(180_000);

/** Registers a case that runs only when every dependency is present. */
type CaseBody = () => void | Promise<unknown>;
const recoveryTest = PENDING
  ? (name: string, fn: CaseBody) => test.skip(name + reason, fn, CASE_TIMEOUT_MS)
  : (name: string, fn: CaseBody) => test(name, fn, CASE_TIMEOUT_MS);

test("preflight: every publication dependency this suite needs is present", () => {
  // Deliberately red while pending. The skipped cases below are NOT evidence;
  // this assertion is the one that says so out loud.
  expect(MISSING).toEqual([]);
});

// ── owned temp directories and datasets ─────────────────────────────────────

/** Scratch directories this file made: child scripts, plans, seed payloads. */
const scratch: string[] = [];
/** Fixture cleanups, owned by the shared helper that created them. */
const fixtureCleanups: (() => Promise<void>)[] = [];

async function scratchDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arra-pub-recovery-${tag}-`));
  scratch.push(dir);
  return dir;
}

afterAll(async () => {
  for (const cleanup of fixtureCleanups.splice(0)) await cleanup();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

// ── child harness: gated owner processes ────────────────────────────────────

type Boundary = "before_append" | "after_revision_append" | "after_revision_readback" | "after_head_publication";
type EmitPark = "before_response_emission" | "after_response_emission";

type Step =
  | { kind: "publish"; operation_id: string; content: Record<string, unknown> }
  | { kind: "head"; workspace_name: string; node_id: string }
  | { kind: "history"; workspace_name: string; node_id: string };

type Plan = {
  datasetRoot: string;
  serviceModule: string;
  /** Epoch-millisecond samples handed to the injected clock, in order. */
  clockMs: number[];
  /** nanoid21 values handed to the injected id source, in order. */
  revisionIds: string[];
  /** Park in the §9 callback at this boundary and wait to be killed. */
  parkAt?: Boundary | null;
  /**
   * Park in the §9 callback at this boundary and wait for the PARENT to say
   * continue. Unlike `parkAt`, this child is meant to finish its work: the
   * pause exists so the parent can inspect the interleaved state while the
   * writer is genuinely mid-publication.
   */
  resumeAt?: Boundary | null;
  /** Throw from the §9 callback at this boundary (fail-stop probe). */
  throwAt?: Boundary | null;
  /** Park in THIS harness around the response emission, after the call returns. */
  emitPark?: EmitPark | null;
  /** Index of the step the parking applies to; later steps run normally. */
  parkStep?: number;
  steps: Step[];
};

type ChildEvent =
  | { event: "ready" }
  | { event: "boundary"; name: Boundary; step: number }
  | { event: "pre_emit"; step: number }
  | { event: "step_result"; step: number; ok: true; value: unknown }
  | { event: "step_result"; step: number; ok: false; error: unknown }
  | { event: "post_emit"; step: number }
  | { event: "done" }
  | { event: "harness_error"; message: string };

/**
 * The owned Bun fault-test child, as source text.
 *
 * It lives under the owned temp root rather than in the source tree: §11 keeps
 * the fault-test child out of the active runtime, and nothing here may become
 * an importable product module. It speaks one line of JSON per event, written
 * straight to fd 1 so a handshake is never stuck in a buffer while the parent
 * waits for it.
 */
const CHILD_SOURCE = `
const planPath = process.argv[2];
const plan = JSON.parse(await Bun.file(planPath).text());

const emit = async (event) => {
  await Bun.write(Bun.stdout, JSON.stringify(event) + "\\n");
};
/** Park forever. The parent owns the deadline, the SIGKILL and the reap. */
const park = () => new Promise(() => {});

// A one-shot resume signal. The parent writes a line on stdin when it has
// finished looking at the interleaved state; nothing here polls or sleeps.
let releaseResume;
const resumed = new Promise((resolve) => { releaseResume = resolve; });
if (plan.resumeAt) {
  (async () => {
    for await (const chunk of Bun.stdin.stream()) {
      if (chunk.length > 0) { releaseResume(); return; }
    }
    // stdin closed without a go-ahead: let the parent deadline handle it.
  })();
}

// service.ts is the only publication entrypoint: no adapter, connection or
// table getter is imported here, and none is reconstructed.
const { openPublicationWriter } = await import(plan.serviceModule);
if (typeof openPublicationWriter !== "function") {
  await emit({ event: "harness_error", message: "openPublicationWriter not exported" });
  process.exit(3);
}

let step = -1;
let clockIndex = 0;
let idIndex = 0;

const clock = () => {
  const value = plan.clockMs[clockIndex];
  if (value === undefined) throw new Error("clock samples exhausted");
  clockIndex += 1;
  return value;
};
const newRevisionId = () => {
  const value = plan.revisionIds[idIndex];
  if (value === undefined) throw new Error("revision ids exhausted");
  idIndex += 1;
  return value;
};
const onBoundary = async (boundary) => {
  if (step !== (plan.parkStep ?? 0)) return;
  if (plan.throwAt === boundary) throw new Error("commanded boundary failure");
  if (plan.resumeAt === boundary) {
    await emit({ event: "boundary", name: boundary, step });
    await resumed;
    return;
  }
  if (plan.parkAt !== boundary) return;
  await emit({ event: "boundary", name: boundary, step });
  await park();
};

const service = await openPublicationWriter(plan.datasetRoot, { clock, newRevisionId, onBoundary });
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));

try {
  await emit({ event: "ready" });
  for (let i = 0; i < plan.steps.length; i++) {
    step = i;
    const spec = plan.steps[i];
    let result;
    let failure = null;
    try {
      if (spec.kind === "publish") {
        result = await service.publishRevision(encode({ operation_id: spec.operation_id, content: spec.content }));
      } else if (spec.kind === "head") {
        result = await service.getAcceptedHead(encode({ workspace_name: spec.workspace_name, node_id: spec.node_id }));
      } else {
        result = await service.listAcceptedHistory(encode({ workspace_name: spec.workspace_name, node_id: spec.node_id }));
      }
    } catch (error) {
      // toJSON is the contract's own envelope; anything else is reported as
      // raw text so an unexpected exception cannot masquerade as a code.
      failure = typeof error?.toJSON === "function"
        ? error.toJSON()
        : { version: null, code: null, path: null, message: String(error && error.message ? error.message : error) };
    }

    // Response-emission boundaries belong to the harness, AFTER the service
    // returned: the write is already durable, only the ACK is in flight.
    if (i === (plan.parkStep ?? 0) && plan.emitPark === "before_response_emission") {
      await emit({ event: "pre_emit", step: i });
      await park();
    }
    await emit(failure === null
      ? { event: "step_result", step: i, ok: true, value: result ?? null }
      : { event: "step_result", step: i, ok: false, error: failure });
    if (i === (plan.parkStep ?? 0) && plan.emitPark === "after_response_emission") {
      await emit({ event: "post_emit", step: i });
      await park();
    }
  }
  await emit({ event: "done" });
} finally {
  try { await service.close(); } catch {}
}
`;

/** Acquire the gate in Python, then become the Bun child. Never returns. */
const LAUNCHER_SOURCE = `
import sys
from arra_migrate.writer_gate import exec_with_gate
exec_with_gate(sys.argv[1], sys.argv[2:])
`;

type ChildRun = {
  events: ChildEvent[];
  exitCode: number | null;
  signalled: boolean;
  stderr: string;
};

type ChildHandle = {
  /** Resolves once the named event has been seen on the handshake stream. */
  waitFor(match: (event: ChildEvent) => boolean): Promise<ChildEvent>;
  /** Whatever the child wrote to stderr; the only clue when it dies early. */
  stderr(): Promise<string>;
  /** Release a child parked at its `resumeAt` boundary. */
  resume(): void;
  /** SIGKILL the exact owned PID, then reap it. Always safe to call twice. */
  killAndReap(): Promise<void>;
  finished(): Promise<ChildRun>;
  pid: number;
};

/**
 * Launch one gated owner process and stream its handshake events.
 *
 * `exec_with_gate` replaces the Python process, so the PID spawned here IS the
 * Bun owner; killing it kills exactly the process that holds the lock, and the
 * kernel releases the flock when it dies. No pattern kill, ever.
 */
async function launchOwner(plan: Plan, tag: string, deadlineMs: number = CHILD_DEADLINE_MS): Promise<ChildHandle> {
  const dir = await scratchDir(`child-${tag}`);
  const childPath = join(dir, "publication-fault-child.ts");
  const planPath = join(dir, "plan.json");
  await writeFile(childPath, CHILD_SOURCE, "utf8");
  await writeFile(planPath, JSON.stringify(plan), "utf8");

  const child = Bun.spawn([PYTHON, "-c", LAUNCHER_SOURCE, plan.datasetRoot, "bun", "run", childPath, planPath], {
    // stdin is a pipe so a parked child can be told to continue; the fd
    // survives the exec that turns Python into the Bun owner.
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PYTHONPATH: PY_SRC },
  });

  const events: ChildEvent[] = [];
  const waiters: { match: (event: ChildEvent) => boolean; resolve: (event: ChildEvent) => void }[] = [];
  let streamClosed = false;
  // Started eagerly and consumed once: when a child dies before its first
  // handshake, this text is the only thing that says why.
  const stderrText = new Response(child.stderr as ReadableStream<Uint8Array>).text();

  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          const event = JSON.parse(line) as ChildEvent;
          events.push(event);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i]!.match(event)) waiters.splice(i, 1)[0]!.resolve(event);
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
    streamClosed = true;
    // Unblock anything still waiting; the deadline race turns this into a
    // clear failure rather than a hang.
    for (const waiter of waiters.splice(0)) waiter.resolve({ event: "harness_error", message: "stream closed" });
  })();

  const deadline = Bun.nanoseconds() + deadlineMs * 1_000_000;
  const remaining = () => Math.max(1, Math.ceil((deadline - Bun.nanoseconds()) / 1_000_000));

  let reaped: Promise<void> | null = null;
  const killAndReap = async () => {
    if (reaped === null) {
      reaped = (async () => {
        try {
          child.kill(9); // exact owned PID, never a pattern
        } catch {
          /* already gone */
        }
        await child.exited;
        await pump.catch(() => undefined);
      })();
    }
    return reaped;
  };

  return {
    pid: child.pid,
    stderr: () => stderrText,
    resume() {
      child.stdin.write("go\n");
      child.stdin.flush();
    },
    async waitFor(match) {
      const already = events.find(match);
      if (already !== undefined) return already;
      if (streamClosed) throw new Error("child stream closed before the expected handshake");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          new Promise<ChildEvent>((resolve) => waiters.push({ match, resolve })),
          new Promise<ChildEvent>((_, rejectDeadline) => {
            timer = setTimeout(() => rejectDeadline(new Error("child deadline exceeded before handshake")), remaining());
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    killAndReap,
    async finished() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          child.exited,
          new Promise((_, rejectDeadline) => {
            timer = setTimeout(() => rejectDeadline(new Error("child deadline exceeded")), remaining());
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      await pump.catch(() => undefined);
      return {
        events,
        exitCode: child.exitCode,
        signalled: child.signalCode !== null,
        stderr: await stderrText,
      };
    },
  };
}

/** Run a plan to completion in one fresh owner; never leaves a child behind. */
async function runOwner(plan: Plan, tag: string): Promise<ChildRun> {
  const owner = await launchOwner(plan, tag);
  try {
    return await owner.finished();
  } finally {
    await owner.killAndReap();
  }
}

/**
 * Run a plan until the child reports it has parked at `stopAt`, then SIGKILL.
 *
 * This is the commanded boundary: the child has told us it is inside the §9
 * callback (or between the service return and the ACK) and is going no
 * further, so the kill lands at a known point in the sequence rather than at
 * whatever the scheduler happened to be doing.
 */
async function runOwnerAndKillAt(
  plan: Plan,
  stopAt: Boundary | EmitPark,
  tag: string,
): Promise<{ parked: ChildEvent; run: ChildRun }> {
  const owner = await launchOwner(plan, tag);
  try {
    const parked = await owner.waitFor((event) =>
      stopAt === "before_response_emission"
        ? event.event === "pre_emit"
        : stopAt === "after_response_emission"
          ? event.event === "post_emit"
          : event.event === "boundary" && event.name === stopAt,
    );
    if (parked.event === "harness_error") {
      // The child never reached the boundary. Its stderr is the evidence, so
      // report that rather than an opaque "stream closed".
      throw new Error(`child never parked at ${stopAt}: ${parked.message}\n${await owner.stderr()}`);
    }
    await owner.killAndReap();
    const run = await owner.finished();
    // A killed owner must not have exited cleanly; that would mean it ran on.
    expect(run.signalled).toBe(true);
    return { parked, run };
  } finally {
    await owner.killAndReap();
  }
}

function stepResult(run: ChildRun, step = 0): { ok: boolean; value?: unknown; error?: unknown } {
  const event = run.events.find((e) => e.event === "step_result" && e.step === step);
  if (event === undefined || event.event !== "step_result") {
    throw new Error(
      `no step_result for step ${step}; events: ${JSON.stringify(run.events)}\nchild stderr:\n${run.stderr}`,
    );
  }
  return event.ok ? { ok: true, value: event.value } : { ok: false, error: event.error };
}

function publishOutcome(run: ChildRun, step = 0): Record<string, unknown> {
  const result = stepResult(run, step);
  if (!result.ok) throw new Error(`publish failed: ${JSON.stringify(result.error)}`);
  return result.value as Record<string, unknown>;
}

function publishError(run: ChildRun, step = 0): Record<string, unknown> {
  const result = stepResult(run, step);
  if (result.ok) throw new Error(`expected a publication error, got ${JSON.stringify(result.value)}`);
  return result.error as Record<string, unknown>;
}

// ── durable evidence: raw rows, read-only, no gate ──────────────────────────

/**
 * Read a column cell as its RAW value.
 *
 * Int64 and timestamp[us] columns are read from the underlying BigInt64Array,
 * never through the row accessor: the accessor divides microseconds by 1000
 * into a lossy Number, so by the time a test could look, an exactness claim
 * would already be unprovable. Strings and booleans come back as themselves.
 */
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

/** Every row of a target table, with raw physical values preserved. */
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

/** BigInt-free, order-stable snapshot for "these rows did not change" checks. */
async function durableSnapshot(datasetRoot: string): Promise<Record<string, unknown>> {
  const stringify = (rows: Record<string, unknown>[]) =>
    rows
      .map((row) =>
        JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? `${value}n` : value)),
      )
      .sort();
  return {
    nodes: stringify(await rawRows(datasetRoot, "nodes")),
    node_revisions: stringify(await rawRows(datasetRoot, "node_revisions")),
  };
}

async function revisionRows(datasetRoot: string, nodeId: string) {
  return (await rawRows(datasetRoot, "node_revisions")).filter((row) => row.node_id === nodeId);
}

async function nodeRows(datasetRoot: string, nodeId: string) {
  return (await rawRows(datasetRoot, "nodes")).filter((row) => row.id === nodeId);
}

/**
 * Narrow a value the child reported as JSON to a string, checking it really is
 * one.
 *
 * The child's results cross a process boundary as JSON, so they arrive typed
 * `unknown`. Asserting the type here is stricter than a cast would be: a
 * missing or non-string field fails the case instead of comparing as
 * `undefined`.
 */
function asText(value: unknown): string {
  expect(typeof value).toBe("string");
  return value as string;
}

/** Exact UTC millisecond text from raw storage microseconds; never rounded. */
function timestampTextFromRaw(micros: unknown): string {
  expect(typeof micros).toBe("bigint");
  const value = micros as bigint;
  expect(value % 1000n).toBe(0n);
  return new Date(Number(value / 1000n)).toISOString();
}

// ── the accepted view, read through the scoped reader (no gate required) ────

async function readerService(datasetRoot: string) {
  const { openPublicationReader } = await import(SERVICE_MODULE);
  return (await openPublicationReader(datasetRoot)) as {
    getAcceptedHead(bytes: Uint8Array): Promise<unknown>;
    listAcceptedHistory(bytes: Uint8Array): Promise<unknown>;
  };
}

/** The shared request encoder; the child harness carries its own copy. */
const encode = encodeRequest;

async function acceptedHead(datasetRoot: string, workspace: string, nodeId: string): Promise<any> {
  const reader = await readerService(datasetRoot);
  return await reader.getAcceptedHead(encode({ workspace_name: workspace, node_id: nodeId }));
}

async function acceptedHistory(datasetRoot: string, workspace: string, nodeId: string): Promise<any> {
  const reader = await readerService(datasetRoot);
  return await reader.listAcceptedHistory(encode({ workspace_name: workspace, node_id: nodeId }));
}

/** The error a scoped read threw, as its contract envelope. */
async function readerFailure(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    const value = await fn();
    throw new Error(`expected a publication error, got ${JSON.stringify(value)}`);
  } catch (error) {
    const envelope = (error as { toJSON?: () => Record<string, unknown> }).toJSON;
    if (typeof envelope !== "function") throw error;
    return envelope.call(error);
  }
}

// ── fixture seeding (shared helper + bounded corrupt-state seeder) ─────────

type Seed = SeededWorkspace;

/**
 * A fresh target19 dataset from the ONLY sanctioned creator (§11), via the
 * shared helper.
 *
 * The creator takes the writer gate itself before its writable connect, so
 * this file never opens a writable connection of its own, and the helper runs
 * it as an owned child with a parent deadline.
 */
async function createFixture(workspaces: string[]): Promise<{ root: string; seeds: Record<string, Seed> }> {
  const fixture = await createSeededFixture(workspaces);
  fixtureCleanups.push(fixture.cleanup);
  return { root: fixture.datasetRoot, seeds: fixture.workspaces };
}

/**
 * Append deliberately corrupt rows under the SAME gate.
 *
 * Duplicate operation rows, a rival claim on one node ID and an
 * unknown-provenance headless node cannot be produced through the service —
 * by design, since the service refuses to create them. They are therefore
 * seeded here, through the real gate, into this test's own disposable dataset,
 * so the recovery paths can be exercised against states the contract says must
 * fail closed.
 */
const SEED_ROWS_SOURCE = `
import json, sys
from datetime import datetime, timedelta

import lancedb
import pyarrow as pa
from arra_migrate.writer_gate import writer_gate

root = sys.argv[1]
plan = json.loads(open(sys.argv[2]).read())
EPOCH = datetime(1970, 1, 1)

def convert(field, value):
    if value is None:
        return None
    if pa.types.is_timestamp(field.type):
        # Exact millisecond arithmetic; never a float division.
        return EPOCH + timedelta(microseconds=int(value) * 1000)
    if pa.types.is_integer(field.type):
        return int(value)
    return value

with writer_gate(root):
    db = lancedb.connect(root)
    for item in plan:
        table = db.open_table(item["table"])
        schema = table.schema
        rows = []
        for row in item["rows"]:
            rows.append({f.name: convert(f, row.get(f.name)) for f in schema})
        table.add(pa.Table.from_pylist(rows, schema=schema))
print(json.dumps({"ok": True}))
`;

/**
 * Seeding runs through the shared owned-child runner: it drains both pipes
 * and holds the child to a parent deadline, so a seeder that hangs is killed
 * by its exact PID rather than stalling the suite.
 */
async function seedRows(datasetRoot: string, rowPlan: { table: string; rows: Record<string, unknown>[] }[]): Promise<void> {
  const dir = await scratchDir("seed");
  const planPath = join(dir, "seed.json");
  await writeFile(planPath, JSON.stringify(rowPlan), "utf8");
  const result = await runOwnedChild(PYTHON, ["-c", SEED_ROWS_SOURCE, datasetRoot, planPath]);
  if (result.code !== 0) throw new Error(`corrupt-state seeder failed (${result.code}): ${result.stderr.slice(0, 400)}`);
}

// ── request building ────────────────────────────────────────────────────────

/** One shared counter, so every generated id in this file is distinct. */
const nextId = idSource("Rec");
function id21(_prefix: string): string {
  return nextId();
}

/**
 * The closed 21-key envelope `revisionOp` consumes, from the shared builder.
 *
 * The helper owns the envelope shape — including `label_snapshot: null`,
 * which §5 requires for new publication — so this file does not carry a
 * second copy of it that could drift.
 */
function content(
  seed: Seed,
  workspace: string,
  nodeId: string,
  options: { base?: string | null; title?: string; body?: string } = {},
): Record<string, unknown> {
  const overrides: Record<string, unknown> = { base_revision_id: options.base ?? null };
  if (options.title !== undefined) overrides.title = options.title;
  if (options.body !== undefined) overrides.body = options.body;
  return revisionEnvelope(workspace, seed, nodeId, overrides);
}

function plan(datasetRoot: string, steps: Step[], extra: Partial<Plan> = {}): Plan {
  return {
    datasetRoot,
    serviceModule: SERVICE_MODULE,
    clockMs: [1_758_000_000_000, 1_758_000_060_000, 1_758_000_120_000, 1_758_000_180_000],
    revisionIds: [id21("Rev"), id21("Rev"), id21("Rev"), id21("Rev")],
    parkAt: null,
    throwAt: null,
    emitPark: null,
    parkStep: 0,
    steps,
    ...extra,
  };
}

// ── A. first-node boundary kills (§7 first node, §9 bullet 2) ───────────────

recoveryTest("A1 before_append: SIGKILL leaves nothing durable and a fresh owner creates the node", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const operationId = "op-a1";
  const body = content(seed, workspace, nodeId);

  const before = await durableSnapshot(root);
  await runOwnerAndKillAt(
    plan(root, [{ kind: "publish", operation_id: operationId, content: body }], { parkAt: "before_append" }),
    "before_append",
    "a1",
  );

  // Nothing was written: the kill landed before the first append.
  expect(await durableSnapshot(root)).toEqual(before);
  expect(await revisionRows(root, nodeId)).toEqual([]);
  expect(await nodeRows(root, nodeId)).toEqual([]);
  expect(await acceptedHead(root, workspace, nodeId)).toBeNull();

  const replay = await runOwner(plan(root, [{ kind: "publish", operation_id: operationId, content: body }]), "a1r");
  const outcome = publishOutcome(replay);
  expect(outcome.outcome).toBe("accepted");
  expect(outcome.revision_no).toBe("1");
  expect(outcome.node_id).toBe(nodeId);

  const revisions = await revisionRows(root, nodeId);
  const nodes = await nodeRows(root, nodeId);
  expect([revisions.length, nodes.length]).toEqual([1, 1]);
  expect(revisions[0]!.base_revision_id).toBeNull();
  expect(revisions[0]!.revision_no).toBe(1n);
  expect(nodes[0]!.current_revision_id).toBe(revisions[0]!.id);
  // §7: the node's timestamps come from the stored revision, not a new sample.
  expect(timestampTextFromRaw(nodes[0]!.created_at)).toBe(timestampTextFromRaw(revisions[0]!.created_at));
  expect(timestampTextFromRaw(nodes[0]!.updated_at)).toBe(timestampTextFromRaw(revisions[0]!.created_at));
});

for (const boundary of ["after_revision_append", "after_revision_readback"] as const) {
  recoveryTest(`A2/A3 ${boundary}: the orphan is durable, invisible, and resumed with its STORED identity`, async () => {
    const { root, seeds } = await createFixture(["wsA", "wsB"]);
    const workspace = "wsA";
    const seed = seeds[workspace]!;
    const nodeId = id21("Node");
    const operationId = `op-${boundary}`;
    const body = content(seed, workspace, nodeId);

    await runOwnerAndKillAt(
      plan(root, [{ kind: "publish", operation_id: operationId, content: body }], { parkAt: boundary }),
      boundary,
      "a2",
    );

    // Durable: exactly one revision row, and NO node. This is the invisible
    // operation-bound orphan §7 describes.
    const orphans = await revisionRows(root, nodeId);
    expect(orphans.length).toBe(1);
    expect(await nodeRows(root, nodeId)).toEqual([]);
    const storedId = orphans[0]!.id as string;
    const storedOrdinal = orphans[0]!.revision_no as bigint;
    const storedCreatedAt = timestampTextFromRaw(orphans[0]!.created_at);
    expect(storedOrdinal).toBe(1n);
    expect(orphans[0]!.base_revision_id).toBeNull();
    expect(orphans[0]!.operation_id).toBe(operationId);

    // Invisible to the accepted view: an absent node is exactly null, and an
    // orphan is never listed as history.
    expect(await acceptedHead(root, workspace, nodeId)).toBeNull();
    expect(await acceptedHistory(root, workspace, nodeId)).toBeNull();

    // A fresh owner resumes the SAME row: a new clock sample and a new id are
    // offered and must both be ignored.
    const replay = await runOwner(
      plan(root, [{ kind: "publish", operation_id: operationId, content: body }], {
        clockMs: [1_759_000_000_000],
        revisionIds: [id21("Unused")],
      }),
      "a2r",
    );
    const outcome = publishOutcome(replay);
    expect(outcome.revision_id).toBe(storedId);
    expect(outcome.revision_no).toBe("1");
    expect(outcome.revision_created_at).toBe(storedCreatedAt);

    const after = await revisionRows(root, nodeId);
    const nodes = await nodeRows(root, nodeId);
    expect([after.length, nodes.length]).toEqual([1, 1]);
    expect(after[0]!.id).toBe(storedId);
    expect(timestampTextFromRaw(after[0]!.created_at)).toBe(storedCreatedAt);
    expect(nodes[0]!.current_revision_id).toBe(storedId);
    expect(timestampTextFromRaw(nodes[0]!.created_at)).toBe(storedCreatedAt);

    const history = await acceptedHistory(root, workspace, nodeId);
    expect(history.revisions.length).toBe(1);
    expect(history.revisions[0].id).toBe(storedId);
    expect(history.snapshot_head_revision_id).toBe(storedId);
  });
}

recoveryTest("A4 after_head_publication: the node is complete and the retry is idempotent on the ORIGINAL values", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const operationId = "op-a4";
  const body = content(seed, workspace, nodeId);

  await runOwnerAndKillAt(
    plan(root, [{ kind: "publish", operation_id: operationId, content: body }], { parkAt: "after_head_publication" }),
    "after_head_publication",
    "a4",
  );

  const revisions = await revisionRows(root, nodeId);
  const nodes = await nodeRows(root, nodeId);
  expect([revisions.length, nodes.length]).toEqual([1, 1]);
  const storedId = revisions[0]!.id as string;
  const storedCreatedAt = timestampTextFromRaw(revisions[0]!.created_at);
  expect(nodes[0]!.current_revision_id).toBe(storedId);

  const snapshot = await durableSnapshot(root);
  const replay = await runOwner(
    plan(root, [{ kind: "publish", operation_id: operationId, content: body }], {
      clockMs: [1_759_000_000_000],
      revisionIds: [id21("Unused")],
    }),
    "a4r",
  );
  const outcome = publishOutcome(replay);
  expect(outcome.outcome).toBe("idempotent");
  expect(outcome.revision_id).toBe(storedId);
  expect(outcome.revision_created_at).toBe(storedCreatedAt);
  // An idempotent replay writes nothing at all.
  expect(await durableSnapshot(root)).toEqual(snapshot);
});

for (const emitPark of ["before_response_emission", "after_response_emission"] as const) {
  recoveryTest(`A5/A6 ${emitPark}: a lost ACK changes nothing and replays idempotently`, async () => {
    const { root, seeds } = await createFixture(["wsA", "wsB"]);
    const workspace = "wsA";
    const seed = seeds[workspace]!;
    const nodeId = id21("Node");
    const operationId = `op-${emitPark}`;
    const body = content(seed, workspace, nodeId);

    const { run } = await runOwnerAndKillAt(
      plan(root, [{ kind: "publish", operation_id: operationId, content: body }], { emitPark }),
      emitPark,
      "a5",
    );
    // The distinction between the two: one died with the result in hand and
    // unsent, the other died having sent it. On disk they are identical.
    const emitted = run.events.some((event) => event.event === "step_result");
    expect(emitted).toBe(emitPark === "after_response_emission");

    const revisions = await revisionRows(root, nodeId);
    const nodes = await nodeRows(root, nodeId);
    expect([revisions.length, nodes.length]).toEqual([1, 1]);
    const storedId = revisions[0]!.id as string;
    const snapshot = await durableSnapshot(root);

    const replay = await runOwner(
      plan(root, [{ kind: "publish", operation_id: operationId, content: body }], {
        clockMs: [1_759_000_000_000],
        revisionIds: [id21("Unused")],
      }),
      "a5r",
    );
    const outcome = publishOutcome(replay);
    expect(outcome.outcome).toBe("idempotent");
    expect(outcome.revision_id).toBe(storedId);
    expect(await durableSnapshot(root)).toEqual(snapshot);
  });
}

// ── B. existing-node boundary kills (§7 existing headed node) ───────────────

/** Publish a first revision from a fresh owner and return its identities. */
async function seedFirstRevision(root: string, seed: Seed, workspace: string, nodeId: string, operationId: string) {
  const run = await runOwner(
    plan(root, [{ kind: "publish", operation_id: operationId, content: content(seed, workspace, nodeId) }]),
    "seed",
  );
  const outcome = publishOutcome(run);
  expect(outcome.outcome).toBe("accepted");
  return outcome;
}

recoveryTest("B2 after_revision_append on an existing node: head unchanged, orphan hidden, resume advances it", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const first = await seedFirstRevision(root, seed, workspace, nodeId, "op-b2-first");

  const second = content(seed, workspace, nodeId, { base: first.revision_id as string, title: "second" });
  await runOwnerAndKillAt(
    plan(root, [{ kind: "publish", operation_id: "op-b2", content: second }], { parkAt: "after_revision_append" }),
    "after_revision_append",
    "b2",
  );

  const rows = await revisionRows(root, nodeId);
  expect(rows.length).toBe(2);
  const orphan = rows.find((row) => row.operation_id === "op-b2")!;
  expect(orphan.base_revision_id).toBe(first.revision_id);
  expect(orphan.revision_no).toBe(2n);
  const storedId = orphan.id as string;
  const storedCreatedAt = timestampTextFromRaw(orphan.created_at);

  // The head did not move, and the accepted history is still just revision 1.
  const nodes = await nodeRows(root, nodeId);
  expect(nodes[0]!.current_revision_id).toBe(first.revision_id);
  const history = await acceptedHistory(root, workspace, nodeId);
  expect(history.revisions.map((row: any) => row.id)).toEqual([first.revision_id]);

  const replay = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-b2", content: second }], {
      clockMs: [1_759_000_000_000],
      revisionIds: [id21("Unused")],
    }),
    "b2r",
  );
  const outcome = publishOutcome(replay);
  expect(outcome.revision_id).toBe(storedId);
  expect(outcome.revision_no).toBe("2");
  expect(outcome.revision_created_at).toBe(storedCreatedAt);
  expect((await revisionRows(root, nodeId)).length).toBe(2);
  expect((await nodeRows(root, nodeId))[0]!.current_revision_id).toBe(storedId);
  const advanced = await acceptedHistory(root, workspace, nodeId);
  expect(advanced.revisions.map((row: any) => row.id)).toEqual([first.revision_id, storedId]);
});

recoveryTest("B3 after_head_publication on an existing node: head advanced, updated_at is the revision's own time", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const first = await seedFirstRevision(root, seed, workspace, nodeId, "op-b3-first");
  const second = content(seed, workspace, nodeId, { base: first.revision_id as string, title: "second" });

  await runOwnerAndKillAt(
    plan(root, [{ kind: "publish", operation_id: "op-b3", content: second }], { parkAt: "after_head_publication" }),
    "after_head_publication",
    "b3",
  );

  const rows = await revisionRows(root, nodeId);
  const appended = rows.find((row) => row.operation_id === "op-b3")!;
  const nodes = await nodeRows(root, nodeId);
  expect(nodes[0]!.current_revision_id).toBe(appended.id);
  // §7 step 4 updates ONLY current_revision_id and updated_at; created_at is
  // still the first revision's timestamp and updated_at is the new one's.
  expect(timestampTextFromRaw(nodes[0]!.created_at)).toBe(asText(first.revision_created_at));
  expect(timestampTextFromRaw(nodes[0]!.updated_at)).toBe(timestampTextFromRaw(appended.created_at));

  const snapshot = await durableSnapshot(root);
  const replay = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-b3", content: second }], {
      clockMs: [1_759_000_000_000],
      revisionIds: [id21("Unused")],
    }),
    "b3r",
  );
  const outcome = publishOutcome(replay);
  expect(outcome.outcome).toBe("idempotent");
  expect(outcome.revision_id).toBe(appended.id);
  expect(await durableSnapshot(root)).toEqual(snapshot);
});

recoveryTest("B4 an orphan whose base is no longer the head stays hidden: stale_base, no new row", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const first = await seedFirstRevision(root, seed, workspace, nodeId, "op-b4-first");
  const orphanContent = content(seed, workspace, nodeId, { base: first.revision_id as string, title: "orphan" });

  await runOwnerAndKillAt(
    plan(root, [{ kind: "publish", operation_id: "op-b4-orphan", content: orphanContent }], {
      parkAt: "after_revision_append",
    }),
    "after_revision_append",
    "b4",
  );
  const orphan = (await revisionRows(root, nodeId)).find((row) => row.operation_id === "op-b4-orphan")!;

  // A different operation now takes the head the orphan was based on.
  const rival = content(seed, workspace, nodeId, { base: first.revision_id as string, title: "rival" });
  const rivalRun = await runOwner(plan(root, [{ kind: "publish", operation_id: "op-b4-rival", content: rival }]), "b4a");
  expect(publishOutcome(rivalRun).outcome).toBe("accepted");

  const snapshot = await durableSnapshot(root);
  const replay = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-b4-orphan", content: orphanContent }]),
    "b4r",
  );
  expect(publishOutcome(replay)).toEqual({ outcome: "conflict", reason: "stale_base" });
  // Nothing written, and the orphan is still not part of accepted history.
  expect(await durableSnapshot(root)).toEqual(snapshot);
  const history = await acceptedHistory(root, workspace, nodeId);
  expect(history.revisions.map((row: any) => row.id)).not.toContain(orphan.id);
});

// ── C. replay and collision matrix (§6), every owner fresh ──────────────────

recoveryTest("C1 same operation, changed payload: operation_digest conflict and no write", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  await seedFirstRevision(root, seed, workspace, nodeId, "op-c1");

  const snapshot = await durableSnapshot(root);
  const changed = content(seed, workspace, nodeId, { body: "different body" });
  const run = await runOwner(plan(root, [{ kind: "publish", operation_id: "op-c1", content: changed }]), "c1");
  expect(publishOutcome(run)).toEqual({ outcome: "conflict", reason: "operation_digest" });
  expect(await durableSnapshot(root)).toEqual(snapshot);
});

recoveryTest("C2 accepted retry after a LATER head returns the original values, not the current head", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const first = await seedFirstRevision(root, seed, workspace, nodeId, "op-c2-first");

  const second = content(seed, workspace, nodeId, { base: first.revision_id as string, title: "second" });
  const secondRun = await runOwner(plan(root, [{ kind: "publish", operation_id: "op-c2-second", content: second }]), "c2a");
  const secondOutcome = publishOutcome(secondRun);

  const replay = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-c2-first", content: content(seed, workspace, nodeId) }]),
    "c2r",
  );
  const outcome = publishOutcome(replay);
  expect(outcome.outcome).toBe("idempotent");
  expect(outcome.revision_id).toBe(first.revision_id);
  expect(outcome.revision_no).toBe("1");
  expect(outcome.revision_created_at).toBe(first.revision_created_at);

  // The current head is a separate question, answered by a separate call.
  const head = await acceptedHead(root, workspace, nodeId);
  expect(head.revision.id).toBe(secondOutcome.revision_id);
});

recoveryTest("C3 first publication onto an already accepted node: node_id conflict", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  await seedFirstRevision(root, seed, workspace, nodeId, "op-c3-first");

  const snapshot = await durableSnapshot(root);
  const run = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-c3-other", content: content(seed, workspace, nodeId, { title: "other" }) }]),
    "c3",
  );
  expect(publishOutcome(run)).toEqual({ outcome: "conflict", reason: "node_id" });
  expect(await durableSnapshot(root)).toEqual(snapshot);
});

recoveryTest("C4 another operation's ORPHAN already claims the node ID: node_id conflict", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");

  await runOwnerAndKillAt(
    plan(root, [{ kind: "publish", operation_id: "op-c4-orphan", content: content(seed, workspace, nodeId) }], {
      parkAt: "after_revision_append",
    }),
    "after_revision_append",
    "c4",
  );
  expect((await revisionRows(root, nodeId)).length).toBe(1);
  expect(await nodeRows(root, nodeId)).toEqual([]);

  const snapshot = await durableSnapshot(root);
  const run = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-c4-other", content: content(seed, workspace, nodeId, { title: "other" }) }]),
    "c4b",
  );
  expect(publishOutcome(run)).toEqual({ outcome: "conflict", reason: "node_id" });
  expect(await durableSnapshot(root)).toEqual(snapshot);
});

recoveryTest("C5 non-null base with no node at all: not_found, nothing written", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const snapshot = await durableSnapshot(root);

  const run = await runOwner(
    plan(root, [
      { kind: "publish", operation_id: "op-c5", content: content(seed, workspace, nodeId, { base: id21("Ghost") }) },
    ]),
    "c5",
  );
  const error = publishError(run);
  expect(error.version).toBe("arra-publication-error/v1");
  expect(error.code).toBe("not_found");
  expect(error.message).toBe("node not found");
  // §8 as ruled by root: an absent node for an append is a publication STATE
  // error and takes the empty path. A pointer is for a missing referenced
  // peer/session/term, which is `invalid_reference`, not this.
  expect(error.path).toBe("");
  expect(await durableSnapshot(root)).toEqual(snapshot);
});

recoveryTest("C6 non-null base that is not the current head: stale_base conflict", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const first = await seedFirstRevision(root, seed, workspace, nodeId, "op-c6-first");
  const second = content(seed, workspace, nodeId, { base: first.revision_id as string, title: "second" });
  await runOwner(plan(root, [{ kind: "publish", operation_id: "op-c6-second", content: second }]), "c6a");

  const snapshot = await durableSnapshot(root);
  const stale = content(seed, workspace, nodeId, { base: first.revision_id as string, title: "stale" });
  const run = await runOwner(plan(root, [{ kind: "publish", operation_id: "op-c6-stale", content: stale }]), "c6b");
  expect(publishOutcome(run)).toEqual({ outcome: "conflict", reason: "stale_base" });
  expect(await durableSnapshot(root)).toEqual(snapshot);
});

recoveryTest("C7 duplicate operation rows: integrity_failure, never an arbitrary winner", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const first = await seedFirstRevision(root, seed, workspace, nodeId, "op-c7");

  // Clone the accepted row under a new revision ID, keeping the operation ID:
  // two rows now claim one logical operation identity.
  const original = (await revisionRows(root, nodeId))[0]!;
  const clone: Record<string, unknown> = { ...original, id: id21("Dup") };
  // The seeder takes timestamps in milliseconds and Int64s as integers, so
  // convert by COLUMN, never by a name suffix: `valid_from`/`valid_to` are
  // timestamps too, and a suffix rule would silently mis-scale them.
  const TIMESTAMP_COLUMNS = new Set(["valid_from", "valid_to", "created_at"]);
  for (const [key, value] of Object.entries(clone)) {
    if (typeof value !== "bigint") continue;
    clone[key] = TIMESTAMP_COLUMNS.has(key) ? Number(value / 1000n) : Number(value);
  }
  await seedRows(root, [{ table: "node_revisions", rows: [clone] }]);

  const snapshot = await durableSnapshot(root);
  const run = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-c7", content: content(seed, workspace, nodeId) }]),
    "c7",
  );
  const error = publishError(run);
  expect(error.version).toBe("arra-publication-error/v1");
  expect(error.code).toBe("integrity_failure");
  expect(error.message).toBe("stored state failed integrity validation");
  expect(await durableSnapshot(root)).toEqual(snapshot);
  expect(first.revision_id).not.toBe(clone.id);
});

recoveryTest("C8 an unknown-provenance headless node is never adopted", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");

  // A node row with a null head, allocated by nobody this kernel knows about.
  await seedRows(root, [
    {
      table: "nodes",
      rows: [
        {
          id: nodeId,
          workspace_name: workspace,
          current_revision_id: null,
          created_at: 1_758_000_000_000,
          updated_at: 1_758_000_000_000,
        },
      ],
    },
  ]);

  // §2: a null-head physical node is an integrity failure, NOT the absent null.
  const readError = await readerFailure(() => acceptedHead(root, workspace, nodeId));
  expect(readError.code).toBe("integrity_failure");

  const snapshot = await durableSnapshot(root);
  const run = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-c8", content: content(seed, workspace, nodeId) }]),
    "c8",
  );
  // §6: reject rather than guess who allocated it. No adopt flag exists, and
  // publication must not quietly claim the node by heading it.
  const error = publishError(run);
  expect(error.code).toBe("integrity_failure");
  expect(await durableSnapshot(root)).toEqual(snapshot);
});

recoveryTest("C9 an orphan whose node ID a RIVAL claim now also holds must not resume into a node", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const body = content(seed, workspace, nodeId);

  // Operation A dies with its revision durable and no node: the recoverable
  // initial orphan of §6.
  await runOwnerAndKillAt(
    plan(root, [{ kind: "publish", operation_id: "op-c9-a", content: body }], { parkAt: "after_revision_append" }),
    "after_revision_append",
    "c9",
  );
  const orphan = (await revisionRows(root, nodeId))[0]!;
  expect(await nodeRows(root, nodeId)).toEqual([]);

  // A rival operation B now also claims that node ID. This state cannot be
  // produced through the service — publishing B would have been refused —
  // so it is seeded under the real gate, which is exactly the corruption a
  // resuming owner has to notice rather than walk past.
  const rival: Record<string, unknown> = {
    ...orphan,
    id: id21("Rival"),
    operation_id: "op-c9-b",
  };
  const TIMESTAMP_COLUMNS = new Set(["valid_from", "valid_to", "created_at"]);
  for (const [key, value] of Object.entries(rival)) {
    if (typeof value !== "bigint") continue;
    rival[key] = TIMESTAMP_COLUMNS.has(key) ? Number(value / 1000n) : Number(value);
  }
  await seedRows(root, [{ table: "node_revisions", rows: [rival] }]);

  const snapshot = await durableSnapshot(root);
  const replay = await runOwner(plan(root, [{ kind: "publish", operation_id: "op-c9-a", content: body }]), "c9r");

  // §6: an absent-node first creation may resume ONLY if no conflicting
  // revision claim appeared. Root ruled this is the node_id conflict
  // classification, so a resume that heads the node here would be adopting a
  // node ID two operations claim.
  expect(publishOutcome(replay)).toEqual({ outcome: "conflict", reason: "node_id" });
  // The load-bearing half of the assertion: nothing was adopted and nothing
  // moved, whatever classification a future reading might prefer.
  expect(await nodeRows(root, nodeId)).toEqual([]);
  expect(await durableSnapshot(root)).toEqual(snapshot);
  expect(await acceptedHead(root, workspace, nodeId)).toBeNull();
});

// ── D. fail-stop and recovery_required (§7 durability boundary, §8) ─────────

recoveryTest("D1/D2 a failure after an attempted write poisons the owner: recovery_required, queue stops", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const otherNodeId = id21("Node");

  // The §9 callback fails AFTER the revision append. Per the amendment this
  // enters the same recovery_required/fail-stop path as any other ambiguous
  // post-write failure, and no queued mutation may run afterwards.
  const run = await runOwner(
    plan(
      root,
      [
        { kind: "publish", operation_id: "op-d1", content: content(seed, workspace, nodeId) },
        { kind: "publish", operation_id: "op-d2", content: content(seed, workspace, otherNodeId) },
      ],
      { throwAt: "after_revision_append" },
    ),
    "d1",
  );

  const first = publishError(run, 0);
  expect(first.version).toBe("arra-publication-error/v1");
  expect(first.code).toBe("recovery_required");
  expect(first.message).toBe("writer recovery required");
  expect(first.path).toBe("");

  // The SECOND request never ran: the owner is poisoned, not merely unlucky.
  const second = publishError(run, 1);
  expect(second.code).toBe("recovery_required");
  expect(await revisionRows(root, otherNodeId)).toEqual([]);
  expect(await nodeRows(root, otherNodeId)).toEqual([]);

  // §8: no delete, no patch, no rollback. The evidence of the attempt stays.
  const orphans = await revisionRows(root, nodeId);
  expect(orphans.length).toBe(1);
  expect(await nodeRows(root, nodeId)).toEqual([]);
});

recoveryTest("D3 a fresh owner after fail-stop retries only the supplied operation, never all orphans", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const strandedNodeId = id21("Node");

  // Two independent orphans, each from its own killed owner.
  await runOwnerAndKillAt(
    plan(root, [{ kind: "publish", operation_id: "op-d3-mine", content: content(seed, workspace, nodeId) }], {
      parkAt: "after_revision_append",
    }),
    "after_revision_append",
    "d3a",
  );
  await runOwnerAndKillAt(
    plan(root, [{ kind: "publish", operation_id: "op-d3-stranded", content: content(seed, workspace, strandedNodeId) }], {
      parkAt: "after_revision_append",
    }),
    "after_revision_append",
    "d3b",
  );
  const mine = (await revisionRows(root, nodeId))[0]!;
  const stranded = (await revisionRows(root, strandedNodeId))[0]!;

  const replay = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-d3-mine", content: content(seed, workspace, nodeId) }]),
    "d3r",
  );
  expect(publishOutcome(replay).revision_id).toBe(mine.id);

  // Startup published exactly one operation: the other orphan is untouched
  // and still has no node of its own.
  expect((await revisionRows(root, strandedNodeId)).map((row) => row.id)).toEqual([stranded.id]);
  expect(await nodeRows(root, strandedNodeId)).toEqual([]);
  expect(await acceptedHead(root, workspace, strandedNodeId)).toBeNull();
});

recoveryTest("D4 a killed owner releases the gate: the next owner acquires it and works", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");

  const { run } = await runOwnerAndKillAt(
    plan(root, [{ kind: "publish", operation_id: "op-d4", content: content(seed, workspace, nodeId) }], {
      parkAt: "before_append",
    }),
    "before_append",
    "d4",
  );
  expect(run.signalled).toBe(true);

  // Precondition for every recovery case above, asserted once here: the flock
  // is released by the kernel when the exact owned PID dies, so a fresh owner
  // can take it. Contention between LIVE writers belongs to the ownership
  // suite, not to this file.
  const next = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-d4", content: content(seed, workspace, nodeId) }]),
    "d4r",
  );
  expect(publishOutcome(next).outcome).toBe("accepted");
});

// ── F. cross-process reading while a writer is mid-publication (§9) ────────

/**
 * Rename and retire seeded taxonomy rows under the REAL gate.
 *
 * §9 asks for historical snapshots to survive a rename/retirement performed
 * in a gate-compliant migration setup — so the migration has to take the same
 * lock a publisher would, not edit the dataset behind its back.
 */
const MIGRATE_TERMS_SOURCE = `
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
            raise SystemExit("migration matched no rows: " + item["where"])
print(json.dumps({"ok": True}))
`;
import { scaledMs } from "./helpers/timing.scaledMs";

async function migrateTerms(
  datasetRoot: string,
  migrations: { table: string; where: string; values: Record<string, unknown> }[],
): Promise<void> {
  const dir = await scratchDir("migrate");
  const planPath = join(dir, "migrate.json");
  await writeFile(planPath, JSON.stringify(migrations), "utf8");
  const result = await runOwnedChild(PYTHON, ["-c", MIGRATE_TERMS_SOURCE, datasetRoot, planPath]);
  if (result.code !== 0) throw new Error(`term migration failed (${result.code}): ${result.stderr.slice(0, 400)}`);
}

recoveryTest("F1 one live reader sees the COMPLETE old chain mid-publication, then refreshes to the complete new one", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const first = await seedFirstRevision(root, seed, workspace, nodeId, "op-f1-first");

  // ONE reader handle, opened BEFORE the second publication starts and kept
  // alive across it. Every read below is asked of this same instance, which
  // is the whole point: a fresh reader per question would prove nothing about
  // stale handles.
  const reader = await readerService(root);
  const request = encode({ workspace_name: workspace, node_id: nodeId });
  const before = (await reader.listAcceptedHistory(request)) as any;
  expect(before.revisions.map((row: any) => row.id)).toEqual([first.revision_id]);

  const second = content(seed, workspace, nodeId, { base: asText(first.revision_id), title: "second" });
  const owner = await launchOwner(
    plan(root, [{ kind: "publish", operation_id: "op-f1", content: second }], {
      resumeAt: "after_revision_append",
    }),
    "f1",
  );
  try {
    await owner.waitFor((event) => event.event === "boundary");

    // The interleave is real, not a reader that merely got there early: the
    // new revision row is already durable on disk at this moment.
    const durable = await revisionRows(root, nodeId);
    expect(durable.length).toBe(2);
    const orphanId = durable.find((row) => row.id !== first.revision_id)!.id;

    // Mid-publication, on the live handle: the complete OLD chain. Never the
    // orphan, never a partial or prepared row.
    //
    // Deep equality, not an ID list: "complete" is a claim about all 26
    // columns of every revision, and a row that lost or corrupted a field
    // while keeping its ID would satisfy an ID comparison perfectly.
    const during = (await reader.listAcceptedHistory(request)) as any;
    expect(during.revisions).toEqual(before.revisions);
    expect(during.node).toEqual(before.node);
    expect(during.snapshot_head_revision_id).toBe(first.revision_id);
    expect(during.revisions.map((row: any) => row.id)).not.toContain(orphanId);
    const duringHead = (await reader.getAcceptedHead(request)) as any;
    expect(duringHead.revision.id).toBe(first.revision_id);

    // Let the writer finish publishing the head.
    owner.resume();
    const run = await owner.finished();
    const outcome = publishOutcome(run);
    expect(outcome.outcome).toBe("accepted");

    // The stale-handle refresh: this handle predates BOTH writes, so serving
    // a cached query result here would look like freshness and be a lie.
    const after = (await reader.listAcceptedHistory(request)) as any;
    expect(after.revisions.map((row: any) => row.id)).toEqual([first.revision_id, outcome.revision_id]);
    expect(after.snapshot_head_revision_id).toBe(outcome.revision_id);
    // The retained first revision must come back EXACTLY as it was read
    // before the second publication: immutable means every field, not just
    // the identifier.
    expect(after.revisions[0]).toEqual(before.revisions[0]);
    const afterHead = (await reader.getAcceptedHead(request)) as any;
    expect(afterHead.revision.id).toBe(outcome.revision_id);
  } finally {
    await owner.killAndReap();
  }
});

recoveryTest("F2 a renamed and retired term keeps its history readable while a NEW assignment of it is refused", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const workspace = "wsA";
  const seed = seeds[workspace]!;
  const nodeId = id21("Node");
  const noteTerm = seed.term_ids.type.note;
  const first = await seedFirstRevision(root, seed, workspace, nodeId, "op-f2-first");

  const before = (await acceptedHistory(root, workspace, nodeId)) as any;
  const snapshotBefore = asText(before.revisions[0].term_snapshot_json);
  expect(snapshotBefore).toContain('"term_name_snapshot":"note"');

  // Gate-compliant migration: the referenced term is renamed AND retired.
  await migrateTerms(root, [
    { table: "terms", where: `id = '${noteTerm.id}'`, values: { name: "note_renamed", is_active: false } },
  ]);

  // §4: accepted history is validated against its OWN frozen snapshot, so it
  // still reads, byte-identical, even though today's taxonomy disagrees.
  const after = (await acceptedHistory(root, workspace, nodeId)) as any;
  expect(asText(after.revisions[0].term_snapshot_json)).toBe(snapshotBefore);
  const head = (await acceptedHead(root, workspace, nodeId)) as any;
  expect(head.revision.id).toBe(first.revision_id);

  // And the original operation still replays idempotently: a rename must not
  // retroactively invalidate an accepted revision.
  const replay = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-f2-first", content: content(seed, workspace, nodeId) }]),
    "f2r",
  );
  expect(publishOutcome(replay).outcome).toBe("idempotent");

  // A NEW publication is live-validated (§5). Two separate refusals follow,
  // and they must be kept apart: a snapshot carrying the PRE-rename name
  // fails the exact-name rule on its own, so it proves nothing about whether
  // inactive terms are enforced.
  const snapshot = await durableSnapshot(root);
  const stale = content(seed, workspace, nodeId, { base: asText(first.revision_id), title: "stale term" });
  const staleRun = await runOwner(plan(root, [{ kind: "publish", operation_id: "op-f2-stale", content: stale }]), "f2s");
  const error = publishError(staleRun);
  expect(error.version).toBe("arra-publication-error/v1");
  expect(error.code).toBe("invalid_reference");
  expect(error.message).toBe("invalid scoped reference");
  // §8 gives reference errors a request pointer; which pointer inside the
  // snapshot is the kernel's choice, so only its presence is required here.
  expect(asText(error.path).length).toBeGreaterThan(0);
  expect(await durableSnapshot(root)).toEqual(snapshot);

  // The isolating case: the SAME retired term, but with the snapshot naming
  // it exactly as the live row now does. The name matches, the vocabulary
  // matches, the IDs match — the only remaining ground for refusal is that
  // the term is no longer active, which is the §5 rule under test.
  const retiredOnly = revisionEnvelope(workspace, seed, nodeId, {
    base_revision_id: asText(first.revision_id),
    title: "retired term, current name",
    term_snapshot_json: JSON.stringify([
      {
        label_snapshot: null,
        position: "0",
        term_id: noteTerm.id,
        term_name_snapshot: "note_renamed",
        vocabulary_id: noteTerm.vocabulary_id,
        vocabulary_name_snapshot: noteTerm.vocabulary_name,
      },
    ]),
  });
  const retiredRun = await runOwner(
    plan(root, [{ kind: "publish", operation_id: "op-f2-retired", content: retiredOnly }]),
    "f2i",
  );
  const retiredError = publishError(retiredRun);
  expect(retiredError.version).toBe("arra-publication-error/v1");
  expect(retiredError.code).toBe("invalid_reference");
  expect(retiredError.message).toBe("invalid scoped reference");
  expect(asText(retiredError.path).length).toBeGreaterThan(0);
  expect(await durableSnapshot(root)).toEqual(snapshot);

  // Control, so the refusals above are about THAT term and not a workspace
  // that simply stopped working: the still-active `decision` term publishes.
  const decision = seed.term_ids.type.decision;
  const live = revisionEnvelope(workspace, seed, nodeId, {
    base_revision_id: asText(first.revision_id),
    title: "live term",
    term_snapshot_json: JSON.stringify([
      {
        label_snapshot: null,
        position: "0",
        term_id: decision.id,
        term_name_snapshot: decision.name,
        vocabulary_id: decision.vocabulary_id,
        vocabulary_name_snapshot: decision.vocabulary_name,
      },
    ]),
  });
  const liveRun = await runOwner(plan(root, [{ kind: "publish", operation_id: "op-f2-live", content: live }]), "f2l");
  expect(publishOutcome(liveRun).outcome).toBe("accepted");
});

// ── harness sensitivity: the bounds themselves must be refutable ───────────

recoveryTest("H1 both child runners really do kill and reap on their own deadline", async () => {
  // A test suite that claims every child is bounded should be able to show
  // the bound firing. Without this, a deadline that silently never fired
  // would look exactly like a suite where nothing ever hung.

  // 1. The shared one-shot runner, against a child that would sleep for two
  //    minutes. It must come back in a fraction of that, non-zero.
  const startedAt = Bun.nanoseconds();
  const hung = await runOwnedChild(PYTHON, ["-c", "import time\ntime.sleep(120)"], { deadlineMs: 750 });
  const elapsedMs = (Bun.nanoseconds() - startedAt) / 1_000_000;
  expect(hung.code).not.toBe(0);
  expect(elapsedMs).toBeLessThan(scaledMs(30_000));

  // 2. This file's own owner harness, against a child parked at a real
  //    boundary that is waiting for a handshake which will never come.
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const seed = seeds.wsA!;
  const nodeId = id21("Node");
  const owner = await launchOwner(
    plan(root, [{ kind: "publish", operation_id: "op-h1", content: content(seed, "wsA", nodeId) }], {
      parkAt: "before_append",
    }),
    "h1",
    6_000,
  );
  try {
    await owner.waitFor((event) => event.event === "boundary");
    let deadlineError: unknown;
    try {
      // Nothing will ever emit this: the child is parked in the callback.
      await owner.waitFor((event) => event.event === "post_emit");
    } catch (error) {
      deadlineError = error;
    }
    expect(String((deadlineError as Error)?.message)).toContain("deadline");
  } finally {
    await owner.killAndReap();
  }
  const run = await owner.finished();
  expect(run.signalled).toBe(true);
  // The parked child died where it was told to park: nothing was appended.
  expect(await revisionRows(root, nodeId)).toEqual([]);
});

// ── E. cross-workspace independence (§6 last line) ──────────────────────────

recoveryTest("E1 the same operation ID in another workspace is a different operation", async () => {
  const { root, seeds } = await createFixture(["wsA", "wsB"]);
  const nodeA = id21("Node");
  const nodeB = id21("Node");
  const operationId = "op-shared";

  const a = await runOwner(
    plan(root, [{ kind: "publish", operation_id: operationId, content: content(seeds.wsA!, "wsA", nodeA) }]),
    "e1a",
  );
  const b = await runOwner(
    plan(root, [{ kind: "publish", operation_id: operationId, content: content(seeds.wsB!, "wsB", nodeB) }]),
    "e1b",
  );
  const outcomeA = publishOutcome(a);
  const outcomeB = publishOutcome(b);
  expect(outcomeB.outcome).toBe("accepted");
  expect(outcomeB.revision_id).not.toBe(outcomeA.revision_id);

  // Each workspace sees only its own node.
  expect(await acceptedHead(root, "wsA", nodeB)).toBeNull();
  expect(await acceptedHead(root, "wsB", nodeA)).toBeNull();
});
