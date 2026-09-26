/**
 * #28 session-link RECOVERY -- lost ACK, fail-stop, and real SDK failures.
 *
 * Contract: `app/docs/contracts/session-link-v1.md`, whose final "Ownership"
 * section states that the ownership, recovery and precision lanes were NOT
 * delivered by the first pass. This file is the recovery half of that gap.
 * The precision lane (Int64 boundary sweep, page-edge arithmetic) is still NOT
 * delivered and nothing here claims it.
 *
 * What this file is responsible for:
 *
 * * Lost ACK on the ONE write path this kernel has. Session links are
 *   create-only: there is no advance/update analogue of the read-cursor
 *   kernel, so the read-cursor recovery lane's update-path sections have no
 *   counterpart here and are deliberately absent rather than faked. A kill
 *   after the SDK append but before the ACK leaves the row discoverable, and a
 *   retry under the SAME caller-stable `id` with the IDENTICAL immutable
 *   payload returns the RETAINED row as `already_satisfied` (decision 1), with
 *   the clock-sample count measured at ZERO rather than inferred.
 * * Retry is CONDITIONAL, not total: the same `id` with a CHANGED immutable
 *   payload is a returned `conflict` carrying the retained row -- no clock, no
 *   write, no poison. `created_by_peer_name` is the field varied, because
 *   decision 6 puts it in the compared payload while keeping it out of
 *   identity.
 * * Safe pre-write refusal leaves the owner usable; any failure after the
 *   attempted write poisons it. Only the owner's state afterwards separates
 *   them, so both are run as two requests on ONE owner.
 * * Real SDK failures at the append and at the readback -- the session_links
 *   table tree made unwritable, then unreadable, by chmod -- surface
 *   `recovery_required` and are not silently normalised into another class.
 *   The parent's repair is an OBSERVED handshake point BEFORE the second
 *   same-owner request, never a repair in `finally`, and a repaired table does
 *   NOT un-poison the owner that saw the fault.
 * * Genuinely distinct governed errors keep their own class: the PARSE-time
 *   self-link `ContractError`, the `invalid_reference` endpoint refusals and
 *   the mid-queue `invalid_request` cycle refusal all leave the SAME owner
 *   usable, which is what distinguishes them from a post-write fault.
 * * Post-readback classification, by an INSTRUMENTED raw-storage interleave
 *   inside the gated child: a duplicate row planted between the write and the
 *   readback is `integrity_failure` AND poisons, proving the owner does not
 *   collapse every post-write fault into `recovery_required`.
 *
 * Bounded claims, stated in the same register as the accepted read-cursor
 * recovery lane and not one notch stronger:
 *
 * * The writer gate is a COOPERATIVE operator protocol. It is not a CAS, and
 *   it is no protection at all against hostile same-UID code that imports the
 *   SDK and declines to take the gate.
 * * Process death here is SIGKILL of a child this parent owns by exact pid. It
 *   is not power loss, not a filesystem or hardware fault, and not a
 *   multiwriter race.
 * * Everything measured is local cooperative-gate behaviour on Darwin with the
 *   pinned Bun and Python in this worktree, against disposable datasets.
 *   Nothing here speaks to Linux, NFS, R2 or multiwriter CAS.
 * * The chmod cases prove what the service reports when the SDK genuinely
 *   fails on THIS table. They do not enumerate SDK failure modes.
 *
 * Cleanup is by CREATION RECORD: every dataset and scratch root is registered
 * when it is made and removed by path, never by prefix or mtime.
 *
 * Ownership: this file and `test/fixtures/session-link-v1/recovery/**` only.
 */
import { afterAll, expect, test } from "bun:test";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@lancedb/lancedb";
import { PYTHON } from "./helpers/publication-fixture";
import { createSessionLinkFixture } from "./helpers/session-link-fixture";
import { scaledMs } from "./helpers/timing.scaledMs";
import { testTimeout } from "./helpers/timing.testTimeout";

// -- dependencies -------------------------------------------------------------

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url)).replace(/\/test\/?$/, "");
const SERVICE_MODULE = join(SERVER_DIR, "src/publication/service.ts");
const RECOVERY_DIR = join(SERVER_DIR, "test/fixtures/session-link-v1/recovery");
const LINK_CHILD = join(RECOVERY_DIR, "link-child.ts");
const SILENT_CHILD = join(RECOVERY_DIR, "silent-child.ts");
const PY_SRC = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));

const MISSING: string[] = [
  [PYTHON, "python interpreter (set ARRA_CONTRACT_PYTHON)"],
  [SERVICE_MODULE, "src/publication/service.ts"],
  [LINK_CHILD, "fixtures/session-link-v1/recovery/link-child.ts"],
  [SILENT_CHILD, "fixtures/session-link-v1/recovery/silent-child.ts"],
]
  .filter(([path]) => !existsSync(path!))
  .map(([, label]) => label!);

// Bounded SOURCE-TEXT check, labelled as such: it separates "core has not
// landed" from "core is broken", and it is not module resolution.
if (existsSync(SERVICE_MODULE)) {
  const source = readFileSync(SERVICE_MODULE, "utf8");
  for (const symbol of ["createSessionLink", "listSessionLinks"]) {
    if (!source.includes(symbol)) MISSING.push(`${symbol} in src/publication/service.ts`);
  }
}

const PENDING = MISSING.length > 0;
const reason = PENDING ? ` [PENDING: ${MISSING.join(", ")}]` : "";
const CASE_TIMEOUT_MS = testTimeout(300_000);
type CaseBody = () => void | Promise<unknown>;
const recoveryTest = PENDING
  ? (name: string, fn: CaseBody) => test.skip(name + reason, fn, CASE_TIMEOUT_MS)
  : (name: string, fn: CaseBody) => test(name, fn, CASE_TIMEOUT_MS);

test("preflight: every session-link dependency this suite needs is present", () => {
  // Red while pending. A skipped case is never acceptance.
  expect(MISSING).toEqual([]);
});

// -- creation records ---------------------------------------------------------

const createdRoots: { path: string; cleanup?: () => Promise<void> }[] = [];

async function scratchDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arra-session-link-recovery-${tag}-`));
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

// -- identities, authored here ------------------------------------------------

const WORKSPACE = "alpha-workspace";
const SESSION_A = "link-session-a";
const SESSION_B = "link-session-b";
const SESSION_C = "link-session-c";
/** A stored fact only: decision 6 keeps this out of identity, and decision 2
 *  forbids a membership rule, so this peer is deliberately NEVER registered. */
const LINK_PEER = "link-peer-name";

let idCounter = 0;
function id21(label: string): string {
  idCounter += 1;
  const body = `Lnk${label}${idCounter}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return (body + "_".repeat(21)).slice(0, 21);
}

const CLOCK_MS = 1_789_905_600_000;
const CLOCK_TEXT = "2026-09-20T12:00:00.000Z";

// -- child harness ------------------------------------------------------------

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

const HANDSHAKE_DEADLINE_MS = scaledMs(60_000);
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

async function launch(spec: Plan, tag: string, script = LINK_CHILD): Promise<Child> {
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

/** How many times the injected clock was sampled in the whole run. Decision 1
 *  says a replay takes NO sample, and a measured zero is stronger evidence
 *  than a timestamp that merely happens to match. */
function clockCalls(result: Run): number {
  const done = result.events.find((event) => event.event === "done");
  if (done === undefined) throw new Error(`run never reported done: ${JSON.stringify(result.events)}`);
  return done.clockCalls as number;
}

/**
 * The ordered event stream, up to and including the first step result.
 *
 * Boundaries and harness events in one sequence, because for the instrumented
 * case the ORDER is the claim: the fault must land after the write boundary
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

/** A THROWN publication error: class name AND all four wire fields. */
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

/** A THROWN governed error, compared as a closed object against the ACTUAL
 *  accepted call-site text in `src/publication/session-link.ts`. */
function expectContractThrown(
  actual: Record<string, unknown> | undefined,
  expected: { code: string; path: string; message: string },
): void {
  expect({
    name: actual?.name,
    version: actual?.version,
    code: actual?.code,
    path: actual?.path,
    message: actual?.message,
  }).toEqual({ name: "ContractError", version: "arra-error/v1", ...expected });
}

// -- durable evidence, read-only and gateless ---------------------------------

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

/** The complete physical session-link rows, with raw Int64 microseconds. */
async function linkRows(datasetRoot: string): Promise<Record<string, unknown>[]> {
  const rows = await rawRows(datasetRoot, "session_links");
  // Ordered by id so a two-row expectation is a comparison and not a race.
  return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** The authored expectation for one stored row, in physical field order. */
function expectedLinkRow(
  linkId: string,
  micros: bigint,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: linkId,
    workspace_name: WORKSPACE,
    from_session_name: SESSION_A,
    to_session_name: SESSION_B,
    relation: "continues",
    evidence_ref: null,
    created_by_peer_name: null,
    created_at: micros,
    ...overrides,
  };
}

const wireTimestamp = (micros: bigint): string => new Date(Number(micros / 1000n)).toISOString();

// -- locking a table tree, for the real SDK failures --------------------------

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

// -- requests and a fixture with real sessions to link ------------------------

const createStep = (linkId: string, overrides: Record<string, unknown> = {}): Step => ({
  facade: "context",
  method: "createSessionLink",
  request: {
    id: linkId,
    workspace_name: WORKSPACE,
    from_session_name: SESSION_A,
    to_session_name: SESSION_B,
    relation: "continues",
    evidence_ref: null,
    created_by_peer_name: null,
    ...overrides,
  },
});

const listStep = (overrides: Record<string, unknown> = {}): Step => ({
  facade: "context",
  method: "listSessionLinks",
  request: {
    workspace_name: WORKSPACE,
    session_name: SESSION_A,
    direction: "from",
    cursor: null,
    limit: 10,
    ...overrides,
  },
});

/**
 * Three real sessions, registered through the accepted context facade, so a
 * link points at rows the service itself wrote. NO peer is registered: decision
 * 2 admits endpoints by existence only and decision 6 keeps
 * `created_by_peer_name` a stored fact, so a peer would prove nothing here.
 */
async function fixtureWithSessions(tag: string): Promise<string> {
  const created = await createSessionLinkFixture([WORKSPACE, "beta-workspace"]);
  createdRoots.push({ path: created.datasetRoot, cleanup: created.cleanup });
  const root = created.datasetRoot;

  const steps: Step[] = [SESSION_A, SESSION_B, SESSION_C].map((name) => ({
    facade: "context",
    method: "registerSession",
    request: { workspace_name: WORKSPACE, session_id: id21("Sess"), name },
  }));
  const seeded = await run(plan(root, steps), `${tag}-seed`);
  for (let i = 0; i < steps.length; i++) {
    expect({ step: i, outcome: okValue(seeded, i).outcome }).toEqual({ step: i, outcome: "created" });
  }
  expect(seeded.exitCode).toBe(0);
  expect(await linkRows(root)).toEqual([]);
  return root;
}

// -- A. lost ACK on the one write path ---------------------------------------

recoveryTest("A1 a created link killed before its ACK is durable and replays with the RETAINED row", async () => {
  const root = await fixtureWithSessions("a1");
  const linkId = id21("A1");

  const killed = await runAndKillAtPark(
    plan(root, [createStep(linkId)], { parkAt: { name: "after_write", n: 1 } }),
    "a1-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("parked");
  // The ACK never left the child: the caller genuinely does not know.
  expect(killed.events.some((event) => event.event === "step_result")).toBe(false);

  // The complete eight-field row is durable, with the microsecond value the
  // injected clock implies -- authored here, not read back from the service.
  expect(await linkRows(root)).toEqual([expectedLinkRow(linkId, BigInt(CLOCK_MS) * 1000n)]);

  // A deliberately later clock on the retry: any resample would show.
  const replay = await run(
    plan(root, [createStep(linkId), listStep()], {
      clockMs: Array.from({ length: 48 }, (_, i) => CLOCK_MS + 500_000 + i * 1000),
    }),
    "a1-replay",
  );
  const result = okValue(replay, 0);
  expect(result.outcome).toBe("already_satisfied");
  expect(result.row).toEqual({
    id: linkId,
    workspace_name: WORKSPACE,
    from_session_name: SESSION_A,
    to_session_name: SESSION_B,
    relation: "continues",
    evidence_ref: null,
    created_by_peer_name: null,
    created_at: CLOCK_TEXT,
  });
  // Decision 1, measured three ways: no clock sample, no boundary triple, and
  // no second row.
  expect(clockCalls(replay)).toBe(0);
  expect(trace(replay)).toEqual([]);
  expect(await linkRows(root)).toEqual([expectedLinkRow(linkId, BigInt(CLOCK_MS) * 1000n)]);
  // Discoverable through the accepted read as well as through the retry.
  expect(okValue(replay, 1)).toEqual({ rows: [result.row], next_cursor: null });
  expect(replay.exitCode).toBe(0);
});

recoveryTest("A2 a kill BEFORE the write leaves no row, and the retry creates one", async () => {
  const root = await fixtureWithSessions("a2");
  const linkId = id21("A2");

  const killed = await runAndKillAtPark(
    plan(root, [createStep(linkId)], { parkAt: { name: "before_write", n: 1 } }),
    "a2-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("parked");
  expect(await linkRows(root)).toEqual([]);

  const retry = await run(plan(root, [createStep(linkId)]), "a2-retry");
  expect(okValue(retry).outcome).toBe("created");
  expect(trace(retry)).toEqual(MUTATION_TRIPLE);
  expect(clockCalls(retry)).toBe(1);
  expect(await linkRows(root)).toEqual([expectedLinkRow(linkId, BigInt(CLOCK_MS) * 1000n)]);
});

// -- B. retry is CONDITIONAL, and that is measured rather than asserted -------

recoveryTest("B1 the same id with a CHANGED payload is a returned conflict that neither writes nor poisons", async () => {
  const root = await fixtureWithSessions("b1");
  const linkId = id21("B1");
  const otherId = id21("B1b");

  const result = await run(
    plan(root, [
      createStep(linkId),
      // Decision 6: `created_by_peer_name` is NOT identity, but it IS part of
      // the compared immutable payload, so this is a conflict rather than a
      // replay -- and the peer named here was never registered, which decision
      // 2 explicitly permits.
      createStep(linkId, { created_by_peer_name: LINK_PEER }),
      // The SAME owner still works afterwards: a returned conflict is not a
      // fault at all.
      createStep(otherId, { to_session_name: SESSION_C }),
    ]),
    "b1",
  );

  expect(okValue(result, 0).outcome).toBe("created");
  const conflict = okValue(result, 1);
  expect(conflict.outcome).toBe("conflict");
  // The RETAINED row is returned, not the requested one.
  expect(conflict.row.created_by_peer_name).toBe(null);
  expect(conflict.row.created_at).toBe(CLOCK_TEXT);
  expect(okValue(result, 2).outcome).toBe("created");

  // Two real mutations, two clock samples, two triples -- the conflict
  // contributed nothing.
  expect(clockCalls(result)).toBe(2);
  expect(trace(result)).toEqual([...MUTATION_TRIPLE, "before_write#2", "after_write#2", "after_readback#2"]);
  expect(await linkRows(root)).toEqual(
    [
      expectedLinkRow(linkId, BigInt(CLOCK_MS) * 1000n),
      expectedLinkRow(otherId, BigInt(CLOCK_MS + 1000) * 1000n, { to_session_name: SESSION_C }),
    ].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  );
  expect(result.exitCode).toBe(0);
});

// -- C. safe pre-write versus post-attempt poison -----------------------------

recoveryTest("C1 a first before_write refusal leaves the owner usable and writes nothing", async () => {
  const root = await fixtureWithSessions("c1");
  const linkId = id21("C1");

  const result = await run(
    plan(root, [createStep(linkId), createStep(linkId)], { throwAt: { name: "before_write", n: 1 } }),
    "c1",
  );
  expectThrown(errorOf(result, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "invalid_request",
    path: "",
  });
  // Nothing was attempted, so the SAME owner still serves the next request.
  expect(okValue(result, 1).outcome).toBe("created");
  // The first attempt DID sample the clock before the hook refused, so the row
  // carries the SECOND sample -- asserted rather than assumed.
  expect(clockCalls(result)).toBe(2);
  expect(await linkRows(root)).toEqual([expectedLinkRow(linkId, BigInt(CLOCK_MS + 1000) * 1000n)]);
});

recoveryTest("C2 a failure AFTER the attempted write poisons the owner and leaves the row in place", async () => {
  const root = await fixtureWithSessions("c2");
  const linkId = id21("C2");

  const result = await run(
    plan(root, [createStep(linkId), createStep(linkId)], { throwAt: { name: "after_write", n: 1 } }),
    "c2",
  );
  expectThrown(errorOf(result, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
  // The second request never runs on that owner: only the owner state
  // separates this case from C1, not the result shape.
  expectThrown(errorOf(result, 1), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
  // No rollback: the attempted row is durable.
  expect(await linkRows(root)).toEqual([expectedLinkRow(linkId, BigInt(CLOCK_MS) * 1000n)]);

  // A FRESH owner converges on it: same id, same payload, retained row.
  const fresh = await run(
    plan(root, [createStep(linkId), listStep()], {
      clockMs: Array.from({ length: 48 }, (_, i) => CLOCK_MS + 500_000 + i * 1000),
    }),
    "c2-fresh",
  );
  const converged = okValue(fresh, 0);
  expect(converged.outcome).toBe("already_satisfied");
  expect(converged.row.created_at).toBe(CLOCK_TEXT);
  expect(clockCalls(fresh)).toBe(0);
  expect(okValue(fresh, 1).rows).toEqual([converged.row]);
  expect(await linkRows(root)).toEqual([expectedLinkRow(linkId, BigInt(CLOCK_MS) * 1000n)]);
});

// -- D. real SDK failures, repaired BEFORE the second same-owner request ------
//
// Session links are create-only, so there are TWO fault points here, not the
// read-cursor lane's three: the append and the readback. An "update" case is
// absent because the kernel has no update path, not because it was skipped.

for (const fault of [
  { label: "the append", park: { name: "before_write" as const, n: 1 }, mode: 0o500, durable: false },
  // Removing read as well makes the post-write verification itself impossible.
  { label: "the readback", park: { name: "after_write" as const, n: 1 }, mode: 0o000, durable: true },
] as const) {
  recoveryTest(`D1 a real SDK failure at ${fault.label} poisons, and a REPAIRED table does not un-poison`, async () => {
    const root = await fixtureWithSessions(`d1-${fault.label.replace(/\s/g, "-")}`);
    const table = join(root, "session_links.lance");
    expect(existsSync(table)).toBe(true);
    const linkId = id21("D1");
    const request = createStep(linkId);
    const lockedClock = CLOCK_MS + 120_000;

    // Commanded end to end so the repair is provably between the two requests.
    const child = await launch(
      plan(root, [request, request], {
        parkAt: fault.park,
        emitPark: "after_response_emission",
        resumeOnStdin: true,
        clockMs: Array.from({ length: 48 }, (_, i) => lockedClock + i * 1000),
      }),
      "d1",
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

    // A REAL SDK failure is reported as the ambiguous-window code, not quietly
    // relabelled as a stored-state fault or a caller fault.
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

    // What is durable differs by fault point, and both are asserted exactly:
    // the append never landed, the readback failed AFTER its row landed.
    const afterFault = await linkRows(root);
    expect(afterFault).toEqual(
      fault.durable ? [expectedLinkRow(linkId, BigInt(lockedClock) * 1000n)] : [],
    );

    // A FRESH owner proves the dataset is usable, and converges the two cases
    // to their own correct outcomes rather than to a permissive "either".
    const freshClock = CLOCK_MS + 240_000;
    const fresh = await run(
      plan(root, [request], { clockMs: Array.from({ length: 48 }, (_, i) => freshClock + i * 1000) }),
      "d1-fresh",
    );
    const recovered = okValue(fresh);
    if (fault.durable) {
      expect(recovered.outcome).toBe("already_satisfied");
      expect(recovered.row.created_at).toBe(wireTimestamp(BigInt(lockedClock) * 1000n));
      expect(clockCalls(fresh)).toBe(0);
      expect(await linkRows(root)).toEqual([expectedLinkRow(linkId, BigInt(lockedClock) * 1000n)]);
    } else {
      expect(recovered.outcome).toBe("created");
      expect(recovered.row.created_at).toBe(wireTimestamp(BigInt(freshClock) * 1000n));
      expect(clockCalls(fresh)).toBe(1);
      expect(await linkRows(root)).toEqual([expectedLinkRow(linkId, BigInt(freshClock) * 1000n)]);
    }
  });
}

// -- E. governed refusals keep their own class and leave the owner usable ----

recoveryTest("E1 parse-time, reference and cycle refusals keep their own class and never poison", async () => {
  const root = await fixtureWithSessions("e1");
  const goodId = id21("E1");
  const cycleId = id21("E1c");
  const lastId = id21("E1d");

  const result = await run(
    plan(root, [
      // (0) Self-link: refused by the PARSER, before the queue, the gate or any
      // workspace lookup exists in the picture. A governed ContractError.
      createStep(id21("E1s"), { to_session_name: SESSION_A }),
      // (1) An endpoint that does not exist: a publication invalid_reference at
      // its own pointer, decided INSIDE the queued turn.
      createStep(id21("E1r"), { to_session_name: "no-such-session" }),
      // (2) A workspace that does not exist, with distinct endpoints, so the
      // pointer is the workspace and not a session.
      createStep(id21("E1w"), { workspace_name: "no-such-workspace" }),
      // (3) The SAME owner still writes: none of the above poisoned it.
      createStep(goodId),
      // (4) The reverse edge would close a two-node cycle. This one DOES enter
      // the queue and does resolve both endpoints, and still fails before any
      // clock sample or write -- as the caller's fault, not stored corruption.
      createStep(cycleId, { from_session_name: SESSION_B, to_session_name: SESSION_A }),
      // (5) And the owner is STILL usable after that mid-queue refusal.
      createStep(lastId, { to_session_name: SESSION_C }),
    ]),
    "e1",
  );

  expectContractThrown(errorOf(result, 0), {
    code: "invalid_value",
    path: "/to_session_name",
    message: "must not equal from_session_name",
  });
  expectThrown(errorOf(result, 1), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "invalid_reference",
    path: "/to_session_name",
  });
  expectThrown(errorOf(result, 2), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "invalid_reference",
    path: "/workspace_name",
  });
  expect(okValue(result, 3).outcome).toBe("created");
  expectThrown(errorOf(result, 4), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "invalid_request",
    path: "/to_session_name",
  });
  expect(okValue(result, 5).outcome).toBe("created");

  // NONE of the four refusals is `recovery_required`, and none cost a clock
  // sample or a boundary: exactly two mutations happened in this whole run.
  for (const step of [0, 1, 2, 4]) {
    expect({ step, code: errorOf(result, step).code }).not.toEqual({ step, code: "recovery_required" });
  }
  expect(clockCalls(result)).toBe(2);
  expect(trace(result)).toEqual([...MUTATION_TRIPLE, "before_write#2", "after_write#2", "after_readback#2"]);
  expect(await linkRows(root)).toEqual(
    [
      expectedLinkRow(goodId, BigInt(CLOCK_MS) * 1000n),
      expectedLinkRow(lastId, BigInt(CLOCK_MS + 1000) * 1000n, { to_session_name: SESSION_C }),
    ].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  );
  expect(result.exitCode).toBe(0);
});

// -- F. post-readback faults, by instrumented in-process interleave ----------
//
// What this case is: evidence of how the service CLASSIFIES state it finds at
// readback. What it is not: a cooperative writer, a concurrency test, or
// evidence about real SDK failures -- section D owns that and is untouched.
// The planted row is authored here, never rebuilt from what the service just
// wrote.

recoveryTest("F1 a duplicate planted before the readback is integrity_failure, and poisons the owner", async () => {
  const root = await fixtureWithSessions("f1");
  const linkId = id21("F1");
  const micros = BigInt(CLOCK_MS) * 1000n;

  const result = await run(
    plan(root, [createStep(linkId), createStep(linkId)], {
      injectAt: { name: "after_write", n: 1 },
      injection: {
        kind: "duplicate_session_link",
        row: {
          id: linkId,
          workspace_name: WORKSPACE,
          from_session_name: SESSION_A,
          to_session_name: SESSION_B,
          relation: "continues",
          evidence_ref: null,
          created_by_peer_name: null,
          created_at_micros: micros.toString(10),
        },
      },
    }),
    "f1",
  );

  // The COMMANDED occurrence fired, not merely some injection somewhere.
  expect(injectedEvent(result)).toEqual({ event: "injected", name: "after_write", n: 1, step: 0 });
  // Ordered evidence: the fault lands after the write boundary and the readback
  // never completes, so no after_readback boundary exists at all.
  expect(sequenceThroughFirstResult(result)).toEqual([
    "ready",
    "boundary:before_write#1",
    "boundary:after_write#1",
    "injected:after_write#1",
    "step_result:0",
  ]);
  expect(trace(result)).not.toContain("after_readback#1");

  // A duplicate found by the readback keeps its STORED-STATE class -- it is not
  // flattened into recovery_required -- and it poisons all the same, because it
  // follows an attempted write.
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
  // No rollback, no repair -- and the exact two authored rows are what remain,
  // which a length check would not have shown.
  expect(await linkRows(root)).toEqual([expectedLinkRow(linkId, micros), expectedLinkRow(linkId, micros)]);
});

// -- G. the parent's own bounds are refutable ---------------------------------

recoveryTest("G1 the parent deadline fires: a silent child is killed and reaped", async () => {
  const created = await createSessionLinkFixture([WORKSPACE]);
  createdRoots.push({ path: created.datasetRoot, cleanup: created.cleanup });
  const child = await launch(plan(created.datasetRoot, []), "g1", SILENT_CHILD);
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
  expect(elapsedMs).toBeLessThan(scaledMs(30_000));
  await child.killAndReap(5_000);
  expect(await linkRows(created.datasetRoot)).toEqual([]);
});
