/**
 * #28 context ingestion recovery — durable prefix, lost ACK, and fail-stop (#61).
 *
 * Contract: `app/docs/contracts/context-ingestion-v1.md`
 * SHA256 9c3c1a0fd41f43b7867dd76530e6294b13a1f85ad9ea8cf053101dfc5923ece5
 * Base: 55ab093af0f28b5f57f41c38b126cd870854f696
 *
 * What this file is responsible for, per §9 RECOVERY, and how each is shown:
 *
 * * A stopped batch keeps its durable prefix, and the prefix is exactly the
 *   rows that were readback-verified — never the failed item.
 * * A lost ACK is recoverable for BOTH local and sourced items: the retry
 *   finds what the previous attempt wrote and returns it with no allocation
 *   and no time drift. For sourced items the anchor is the source tuple, so a
 *   different unoccupied proposed `public_id` is ignored.
 * * The three failure classes are distinguished by the OWNER STATE they leave,
 *   which no result shape reveals: a known conflict leaves the owner usable, a
 *   safe error after an earlier attempted row poisons it, and a first
 *   `before_write` hook failure with nothing attempted leaves it usable.
 * * A real SDK failure — at the append and, separately, at the readback — is
 *   followed by repairing the filesystem BEFORE the second call, so fail-stop
 *   is distinguished from a dataset that simply stayed broken.
 * * Every error is asserted by name AND version AND code AND path. The code
 *   alone is shared across envelopes and proves nothing about which one it is.
 *
 * Bounded claims: process death and SDK-reported failure on local Darwin/POSIX
 * with the pinned Python/Bun. Not power loss, not filesystem hardware, not
 * multiwriter; the gate stays a cooperative operator protocol.
 *
 * Identities and expectations here are authored in this file. The shared
 * builders may produce equivalent requests, but a test whose expected values
 * come from the same helper that builds its inputs is checking a helper
 * against itself.
 *
 * Ownership: this file and `test/fixtures/context-v1/recovery/**` only.
 * Registration grammar, scoped refs, read history and surface exactness belong
 * to the ownership suite; ordering, precision and pagination to the precision
 * suite. Accepted #26/#27 files are untouched.
 */
import { afterAll, expect, test } from "bun:test";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@lancedb/lancedb";
import { PYTHON } from "./helpers/publication-fixture";
import { createTaxonomyFixture } from "./helpers/taxonomy-fixture";
import { scaledMs } from "./helpers/timing.scaledMs";
import { testTimeout } from "./helpers/timing.testTimeout";

// ── dependencies ────────────────────────────────────────────────────────────

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url)).replace(/\/test\/?$/, "");
const SERVICE_MODULE = join(SERVER_DIR, "src/publication/service.ts");
const CHILD_SCRIPT = join(SERVER_DIR, "test/fixtures/context-v1/recovery/context-child.ts");
const SILENT_CHILD = join(SERVER_DIR, "test/fixtures/context-v1/recovery/silent-child.ts");
const PY_SRC = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));
const EXPORTER = fileURLToPath(new URL("../../migrate-py/tests/export_taxonomy_fixture.py", import.meta.url));

const MISSING: string[] = [
  [PYTHON, "python interpreter (set ARRA_CONTRACT_PYTHON)"],
  [EXPORTER, "export_taxonomy_fixture.py (accepted bare fixture creator)"],
  [SERVICE_MODULE, "src/publication/service.ts"],
  [CHILD_SCRIPT, "test/fixtures/context-v1/recovery/context-child.ts"],
  [SILENT_CHILD, "test/fixtures/context-v1/recovery/silent-child.ts"],
]
  .filter(([path]) => !existsSync(path!))
  .map(([, label]) => label!);

// A present service.ts is not yet a context-capable one. Bounded SOURCE-TEXT
// check, stated as such: it distinguishes "core has not landed" from "core is
// broken", and it is not module resolution.
if (existsSync(SERVICE_MODULE) && !readFileSync(SERVICE_MODULE, "utf8").includes("openContextWriter")) {
  MISSING.push("openContextWriter in src/publication/service.ts (#59)");
}

const PENDING = MISSING.length > 0;
const reason = PENDING ? ` [PENDING: ${MISSING.join(", ")}]` : "";
/** Real fixtures and two or three gated processes per case. */
const CASE_TIMEOUT_MS = testTimeout(240_000);
type CaseBody = () => void | Promise<unknown>;
const recoveryTest = PENDING
  ? (name: string, fn: CaseBody) => test.skip(name + reason, fn, CASE_TIMEOUT_MS)
  : (name: string, fn: CaseBody) => test(name, fn, CASE_TIMEOUT_MS);

test("preflight: every context dependency this suite needs is present", () => {
  // Red while pending. A skipped case is never acceptance.
  expect(MISSING).toEqual([]);
});

// ── owned scratch ───────────────────────────────────────────────────────────

const scratch: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

async function scratchDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arra-ctx-recovery-${tag}-`));
  scratch.push(dir);
  return dir;
}

afterAll(async () => {
  // Each teardown is isolated. The first version awaited them in a bare loop,
  // so ONE failing cleanup aborted the rest and stranded every remaining
  // fixture and scratch directory — which is exactly what happened when a
  // locked tree could not be removed. A teardown that gives up halfway is
  // worse than none, because the leftovers look like someone else's.
  const failures: string[] = [];
  for (const cleanup of cleanups.splice(0)) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(String((error as Error)?.message ?? error));
    }
  }
  for (const dir of scratch.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      failures.push(String((error as Error)?.message ?? error));
    }
  }
  // Reported rather than swallowed: a leftover root is evidence of a defect,
  // not housekeeping noise.
  if (failures.length > 0) throw new Error(`teardown left ${failures.length} path(s): ${failures.join("; ")}`);
});

const WORKSPACE = "alpha-workspace";

/** A fresh bare dataset from the accepted taxonomy creator; no second creator. */
async function freshDataset(): Promise<string> {
  const fixture = await createTaxonomyFixture([WORKSPACE, "beta-workspace"]);
  cleanups.push(fixture.cleanup);
  return fixture.datasetRoot;
}

// ── identities, authored here ───────────────────────────────────────────────

let idCounter = 0;
/** A distinct valid nanoid21. Authored locally, not taken from a builder. */
function id21(label: string): string {
  idCounter += 1;
  const body = `Ctx${label}${idCounter}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return (body + "_".repeat(21)).slice(0, 21);
}

const SESSION = "recovery-session";
const PEER = "recovery-peer";
const NAMESPACE = "arra-test/recovery-namespace";

type Item = {
  public_id: string;
  message: { peer_name: string; role: string | null; content: string; in_reply_to: string | null };
  source: null | { source_message_id: string; source_created_at: string | null; supplied_digest: string | null };
};

/** A local item. Source key names are the governed ones; no abbreviations. */
function localItem(content: string, overrides: Partial<Item> = {}): Item {
  return {
    public_id: id21("Msg"),
    message: { peer_name: PEER, role: "user", content, in_reply_to: null },
    source: null,
    ...overrides,
  };
}

/** A sourced item, whose replay anchor is the source tuple, not public_id. */
function sourcedItem(content: string, sourceMessageId: string, overrides: Partial<Item> = {}): Item {
  return {
    public_id: id21("Msg"),
    message: { peer_name: PEER, role: "user", content, in_reply_to: null },
    source: { source_message_id: sourceMessageId, source_created_at: null, supplied_digest: null },
    ...overrides,
  };
}

const appendRequest = (items: Item[]) => ({
  workspace_name: WORKSPACE,
  session_name: SESSION,
  items,
});

// ── child harness ───────────────────────────────────────────────────────────

type Boundary = "before_write" | "after_write" | "after_readback";
type Facade = "context" | "publication" | "taxonomy";
type Step = { facade: Facade; method: string; request: Record<string, unknown> };
type ChildEvent = Record<string, any>;

type Plan = {
  datasetRoot: string;
  serviceModule: string;
  sourceNamespace: string | null;
  clockMs: number[];
  revisionIds: string[];
  parkAt?: { name: Boundary; n: number } | null;
  throwAt?: { name: Boundary; n: number } | null;
  emitPark?: "before_response_emission" | "after_response_emission" | null;
  resumeOnStdin?: boolean;
  parkStep?: number;
  steps: Step[];
};

const INTAKE_MS = 1_789_920_000_000;
/** Every parent wait is bounded by this, never by the test runner. */
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
    // One sample per NEW row plus spares; a replay must consume none.
    clockMs: Array.from({ length: 32 }, (_, i) => INTAKE_MS + i * 1000),
    revisionIds: Array.from({ length: 4 }, () => id21("Rev")),
    parkAt: null,
    throwAt: null,
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
  readonly pid: number | undefined;
  nextEvent(deadlineMs?: number): Promise<ChildEvent>;
  resume(): void;
  endInput(): void;
  waitForExit(deadlineMs?: number): Promise<number>;
  killAndReap(deadlineMs?: number): Promise<void>;
  stderr(): string;
};

async function launch(spec: Plan, tag: string, script = CHILD_SCRIPT): Promise<Child> {
  const dir = await scratchDir(tag);
  const planPath = join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify(spec), "utf8");

  const child = Bun.spawn([PYTHON, "-c", LAUNCHER_SOURCE, spec.datasetRoot, process.execPath, script, planPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PYTHONPATH: PY_SRC },
  });

  // Drained continuously and capped: an undrained pipe can fill and block the
  // child, which reads as a hang rather than an error.
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
        // Measured, never constructed.
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

/** Run a plan to completion, with a measured exit code. */
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
    const exitCode = await child.waitForExit();
    return { events, exitCode, stderr: child.stderr() };
  } finally {
    await child.killAndReap();
  }
}

/** Run until the child parks, then SIGKILL its exact pid. */
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
    // A killed child has no meaningful exit status of its own; -1 records that
    // the parent ended it rather than pretending it completed.
    return { events, exitCode: -1, stderr: child.stderr() };
  } finally {
    await child.killAndReap();
  }
}

function trace(result: Run): { name: string; n: number }[] {
  return result.events.filter((e) => e.event === "boundary").map((e) => ({ name: e.name, n: e.n }));
}

/** The frozen per-row triple, repeated for `rows` new rows. */
function expectedTrace(rows: number): { name: string; n: number }[] {
  const counts: Record<string, number> = {};
  const next = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return { name, n: counts[name]! };
  };
  return Array.from({ length: rows }).flatMap(() => [next("before_write"), next("after_write"), next("after_readback")]);
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

/**
 * Assert a THROWN error: name AND version AND code AND path.
 *
 * The permitted codes overlap between the two governed envelopes, so a
 * code-only assertion cannot say which envelope produced it — that is exactly
 * how an envelope defect survives a suite. `name` is available here because
 * the child reads it off the actual thrown instance.
 */
function expectThrown(
  actual: Record<string, unknown> | undefined,
  expected: { name: string; version: string; code: string; path: string },
): void {
  expect({
    name: actual?.name,
    version: actual?.version,
    code: actual?.code,
    path: actual?.path,
  }).toEqual(expected);
}

/**
 * Assert a SERIALIZED `stop.error`: version, code, path AND message.
 *
 * Deliberately not `name`. `stop.error` is the contract's `toJSON()` envelope,
 * which carries version/code/path/message and no class name; demanding a name
 * there would either fail against a correct implementation or, worse, invite
 * one to fabricate the field. The message is asserted instead, since it is the
 * fixed literal the envelope does define.
 */
function expectStopError(
  actual: Record<string, unknown> | undefined,
  expected: { version: string; code: string; path: string; message: string },
): void {
  expect({
    version: actual?.version,
    code: actual?.code,
    path: actual?.path,
    message: actual?.message,
  }).toEqual(expected);
  // And it must NOT have grown a name to satisfy a test.
  expect(actual).not.toHaveProperty("name");
}

const PUBLICATION_ENVELOPE = "arra-publication-error/v1";
/** Fixed literal messages from the governed envelope. */
const MESSAGES = {
  invalid_request: "invalid publication request",
  invalid_reference: "invalid scoped reference",
  recovery_required: "writer recovery required",
} as const;

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

async function messageRows(datasetRoot: string): Promise<Record<string, unknown>[]> {
  const rows = await rawRows(datasetRoot, "messages");
  return rows.sort((a, b) => Number((a.seq_in_session as bigint) - (b.seq_in_session as bigint)));
}

async function publicIds(datasetRoot: string): Promise<string[]> {
  return (await messageRows(datasetRoot)).map((row) => row.public_id as string);
}

async function snapshot(datasetRoot: string): Promise<string[]> {
  return (await rawRows(datasetRoot, "messages"))
    .map((row) => JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)))
    .sort();
}

/**
 * Lock a Lance table directory and everything beneath it.
 *
 * Measured in the #27 lane: removing write permission from the DATASET ROOT
 * alone does not stop an append into an existing table subdirectory, because
 * the new files land inside `<table>.lance/`. Children are locked first, so
 * each one is still reachable when its turn comes.
 */
async function lockTree(dir: string, mode: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await lockTree(join(dir, entry.name), mode);
  }
  await chmod(dir, mode);
}

/**
 * Restore a locked tree, parent first.
 *
 * Direction matters and the first version of this got it wrong: a mode of
 * 0o000 removes READ and EXECUTE, so a restore that enumerates the tree
 * before chmodding cannot list what it just made unlistable. It failed with
 * EACCES, left the fixture unreadable, and took the suite's cleanup down with
 * it. Each directory is therefore made traversable BEFORE it is read.
 */
async function unlockTree(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await unlockTree(join(dir, entry.name));
  }
}

// ── registration, done in its own owner so append traces stay clean ─────────
//
// Deliberate, and load-bearing: §7 gives registration writes the SAME triples
// as message rows, so a hook armed at `before_write#1` inside a plan that also
// registers would fire on the peer row and never reach the message under test.
// Registration therefore runs in its own earlier owner, and every counted
// occurrence in an append plan belongs to a message. Folding these back into
// one plan would silently retarget every commanded fault in this file.

const registrationSteps = (): Step[] => [
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
];

/** A dataset with a peer, a session and an active membership. */
async function seededDataset(tag: string): Promise<string> {
  const root = await freshDataset();
  const seeded = await run(plan(root, registrationSteps()), `${tag}-seed`);
  for (const step of [0, 1, 2]) expect(okValue(seeded, step).outcome).toBe("created");
  expect(seeded.exitCode).toBe(0);
  return root;
}

const appendStep = (items: Item[]): Step => ({
  facade: "context",
  method: "appendMessages",
  request: appendRequest(items),
});

// ── R1. a complete batch: trace, prefix and persisted identities ────────────

recoveryTest("R1 a complete append emits one triple per row and persists exactly the requested identities", async () => {
  const root = await seededDataset("r1");
  const items = [localItem("first"), localItem("second"), localItem("third")];

  const result = await run(plan(root, [appendStep(items)]), "r1");
  const batch = okValue(result);
  expect(batch.outcome).toBe("complete");
  expect(batch.stop).toBeNull();
  expect(batch.results.map((entry: any) => [entry.index, entry.outcome])).toEqual([
    [0, "accepted"],
    [1, "accepted"],
    [2, "accepted"],
  ]);

  expect(trace(result)).toEqual(expectedTrace(3));
  expect(await publicIds(root)).toEqual(items.map((item) => item.public_id));
  expect((await messageRows(root)).map((row) => (row.seq_in_session as bigint).toString())).toEqual(["1", "2", "3"]);
  expect(result.exitCode).toBe(0);
});

// ── R2/R3. lost ACK, local and sourced ──────────────────────────────────────

recoveryTest("R2 a LOCAL row durable but unacknowledged is replayed by its caller-stable public_id, with no drift", async () => {
  const root = await seededDataset("r2");
  const items = [localItem("first"), localItem("second")];

  // Killed after the append and before the readback: the row is durable and
  // the caller never learned it.
  const killed = await runAndKillAtPark(
    plan(root, [appendStep(items)], { parkAt: { name: "after_write", n: 1 } }),
    "r2-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("parked");
  expect(killed.events.some((event) => event.event === "step_result")).toBe(false);

  const durable = await messageRows(root);
  expect(durable.length).toBe(1);
  const stored = durable[0]!;
  expect(stored.public_id).toBe(items[0]!.public_id);

  // A different clock on the retry: any resampled timestamp would show.
  const replay = await run(
    plan(root, [appendStep(items)], {
      clockMs: Array.from({ length: 32 }, (_, i) => INTAKE_MS + 500_000 + i * 1000),
    }),
    "r2-replay",
  );
  const batch = okValue(replay);
  expect(batch.outcome).toBe("complete");
  expect(batch.results.map((entry: any) => entry.outcome)).toEqual(["idempotent", "accepted"]);

  const after = await messageRows(root);
  expect(after.length).toBe(2);
  const replayed = after[0]!;
  // No allocation and no time drift: every retained field is the stored one.
  expect(replayed.id).toBe(stored.id);
  expect(replayed.seq_in_session).toBe(stored.seq_in_session);
  expect(replayed.created_at).toBe(stored.created_at);
  expect(replayed.ingested_at).toBe(stored.ingested_at);
  // Only the second row was written this time.
  expect(trace(replay)).toEqual(expectedTrace(1));
});

recoveryTest("R3 a SOURCED row is replayed by its source tuple, ignoring a different unoccupied proposal", async () => {
  const root = await seededDataset("r3");
  const sourceId = "source-message-0001";
  const first = sourcedItem("sourced first", sourceId);

  const killed = await runAndKillAtPark(
    plan(root, [appendStep([first])], { sourceNamespace: NAMESPACE, parkAt: { name: "after_write", n: 1 } }),
    "r3-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("parked");
  const stored = (await messageRows(root))[0]!;
  expect(stored.public_id).toBe(first.public_id);
  expect(stored.source_message_id).toBe(sourceId);

  // Same source identity, DIFFERENT and unoccupied proposed public_id.
  const retried = { ...first, public_id: id21("Msg") };
  expect(retried.public_id).not.toBe(first.public_id);
  const replay = await run(
    plan(root, [appendStep([retried])], {
      sourceNamespace: NAMESPACE,
      clockMs: Array.from({ length: 32 }, (_, i) => INTAKE_MS + 900_000 + i * 1000),
    }),
    "r3-replay",
  );
  const batch = okValue(replay);
  expect(batch.results.map((entry: any) => entry.outcome)).toEqual(["idempotent"]);
  // The ORIGINAL public_id comes back; the proposal is ignored, not adopted.
  expect(batch.results[0].row.public_id).toBe(first.public_id);
  expect(await publicIds(root)).toEqual([first.public_id]);
  expect(trace(replay)).toEqual([]);
});

// ── R4/R5/R6. three failure classes, told apart by owner state ──────────────

recoveryTest("R4 a known conflict stops the batch, keeps the prefix, and leaves the owner USABLE", async () => {
  const root = await seededDataset("r4");
  const existing = localItem("already here");
  const seeded = await run(plan(root, [appendStep([existing])]), "r4-seed");
  expect(okValue(seeded).outcome).toBe("complete");

  const accepted = localItem("accepted prefix");
  const occupied = { ...localItem("occupied proposal"), public_id: existing.public_id };
  const later = localItem("never attempted");

  const followUp = localItem("after the conflict");
  const result = await run(
    plan(root, [
      appendStep([accepted, occupied, later]),
      // Same owner, afterwards: a known conflict is a classification, not an
      // ambiguous write, so this must still be served.
      appendStep([followUp]),
    ]),
    "r4",
  );

  const batch = okValue(result, 0);
  expect(batch.outcome).toBe("stopped");
  expect(batch.results.map((entry: any) => [entry.index, entry.outcome])).toEqual([[0, "accepted"]]);
  expect(batch.stop).toEqual({ index: 1, conflict: "public_id" });
  // The owner survived: the follow-up call on the SAME owner succeeded.
  expect(okValue(result, 1).outcome).toBe("complete");

  // Exact identities, in sequence order: the seeded row, the accepted prefix
  // and the follow-up. The item that named an occupied ID never wrote, and
  // neither did the item after it.
  expect(await publicIds(root)).toEqual([existing.public_id, accepted.public_id, followUp.public_id]);
  expect(await publicIds(root)).not.toContain(later.public_id);
  expect(result.exitCode).toBe(0);
});

recoveryTest("R5 a safe error AFTER a durable row stops the batch and POISONS the owner", async () => {
  const root = await seededDataset("r5");
  const accepted = localItem("accepted prefix");
  const dangling = localItem("bad reply", { message: { peer_name: PEER, role: "user", content: "bad reply", in_reply_to: id21("Ghost") } });
  const later = localItem("never attempted");

  const result = await run(
    plan(root, [appendStep([accepted, dangling, later]), appendStep([localItem("after the poison")])]),
    "r5",
  );

  const batch = okValue(result, 0);
  expect(batch.outcome).toBe("stopped");
  expect(batch.results.map((entry: any) => entry.index)).toEqual([0]);
  expect(batch.stop.index).toBe(1);
  expectStopError(batch.stop.error, {
    version: PUBLICATION_ENVELOPE,
    code: "invalid_reference",
    path: "/items/1/message/in_reply_to",
    message: MESSAGES.invalid_reference,
  });

  // The prefix is durable and the later item was never attempted.
  expect(await publicIds(root)).toEqual([accepted.public_id]);

  // The owner is poisoned: the SAME owner's next call is refused. This is the
  // assertion that distinguishes this case from R4 — the result shapes alone
  // do not.
  expectThrown(errorOf(result, 1), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
});

recoveryTest("R6 a first before_write hook failure stops with an EMPTY prefix and leaves the owner usable", async () => {
  const root = await seededDataset("r6");
  const items = [localItem("first"), localItem("second")];
  // Named before the run: the follow-up SUCCEEDS, so it persists a row. An
  // "empty dataset" assertion after both calls would either fail or, worse,
  // pass by the follow-up having quietly written nothing.
  const followUp = localItem("after the refusal");

  const result = await run(
    plan(root, [appendStep(items), appendStep([followUp])], {
      throwAt: { name: "before_write", n: 1 },
    }),
    "r6",
  );

  const batch = okValue(result, 0);
  expect(batch.outcome).toBe("stopped");
  expect(batch.results).toEqual([]);
  expect(batch.stop.index).toBe(0);
  expectStopError(batch.stop.error, {
    version: PUBLICATION_ENVELOPE,
    code: "invalid_request",
    path: "",
    message: MESSAGES.invalid_request,
  });
  // The owner still works, and the only durable row is the follow-up: neither
  // refused item reached storage, which is what "nothing was attempted" means
  // once a successful call has also run on this owner.
  expect(okValue(result, 1).outcome).toBe("complete");
  const persisted = await publicIds(root);
  expect(persisted).toEqual([followUp.public_id]);
  expect(persisted).not.toContain(items[0]!.public_id);
  expect(persisted).not.toContain(items[1]!.public_id);
});

// ── R7/R8. real SDK failures, repaired BEFORE the second call ───────────────

for (const fault of [
  { label: "an append", park: { name: "before_write" as const, n: 1 }, mode: 0o500 },
  // Removing read as well makes the post-write verification itself impossible,
  // which is the ambiguous case: the row may or may not be there.
  { label: "a readback", park: { name: "after_write" as const, n: 1 }, mode: 0o000 },
] as const) {
  recoveryTest(`R7/R8 a real SDK failure at ${fault.label} poisons, and a REPAIRED table does not un-poison`, async () => {
    const root = await seededDataset(`r7-${fault.label.replace(/\s/g, "-")}`);
    const table = join(root, "messages.lance");
    const items = [localItem("doomed")];

    // The ordering IS the case, so the parent commands every step and the
    // child cannot advance on its own:
    //   park at the fault boundary -> parent LOCKS the table
    //   -> release -> real SDK failure -> child parks with its result reported
    //   -> parent REPAIRS and proves the table writable
    //   -> release -> second request on the SAME owner
    // Repairing only in a `finally` would leave the second request running
    // against a still-broken table, and its refusal would prove nothing about
    // poison. That is the defect this shape exists to avoid.
    const child = await launch(
      plan(root, [appendStep(items), appendStep([localItem("after the failure")])], {
        parkAt: fault.park,
        emitPark: "after_response_emission",
        resumeOnStdin: true,
      }),
      "r7",
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

      // The first request fails against a genuinely broken table, and the
      // child stops with that result already reported.
      await until("step_result");
      await until("post_emit");

      // REPAIRED HERE, with the child parked and provably not yet inside its
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
    // Measured, not constructed: the child finished on its own.
    expect(exitCode).toBe(0);

    // The literal order the argument depends on, with the repair in it.
    expect(observed).toEqual([
      "ready",
      "parked",
      "step_result",
      "post_emit",
      "repaired",
      "step_result",
      "done",
    ]);

    const batch = okValue(result, 0);
    expect(batch.outcome).toBe("stopped");
    expect(batch.results).toEqual([]);
    expectStopError(batch.stop.error, {
      version: PUBLICATION_ENVELOPE,
      code: "recovery_required",
      path: "",
      message: MESSAGES.recovery_required,
    });

    // The table is writable again and the SAME owner is still refused, so the
    // refusal is the owner's state rather than the filesystem's.
    expectThrown(errorOf(result, 1), {
      name: "PublicationError",
      version: PUBLICATION_ENVELOPE,
      code: "recovery_required",
      path: "",
    });

    // A fresh owner proves the dataset is usable, and discovers whatever
    // durable state the failed attempt left — possibly more than the caller
    // was ever told about.
    const fresh = await run(plan(root, [appendStep(items)]), "r7-fresh");
    const recovered = okValue(fresh);
    expect(recovered.outcome).toBe("complete");
    expect(recovered.results[0].row.public_id).toBe(items[0]!.public_id);
    expect(await publicIds(root)).toEqual([items[0]!.public_id]);
  });
}

// ── R9. the parent's own bounds are refutable ───────────────────────────────

recoveryTest("R9 the parent deadline fires: a silent child is killed and reaped", async () => {
  // Every case above trusts these deadlines. A timeout that never trips looks
  // exactly like one that does not work, and the runner's own timeout is not
  // evidence of parent-side cleanup.
  const root = await freshDataset();
  const child = await launch(plan(root, []), "r9", SILENT_CHILD);
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
  // Configured at 1.5s: asserted to have waited about that long, so it was the
  // deadline firing, and to have returned far inside the runner timeout. A
  // strict upper bound of 1.5s would be a flaky claim under jitter.
  expect(elapsedMs).toBeGreaterThan(configuredMs * 0.9);
  expect(elapsedMs).toBeLessThan(scaledMs(30_000));
  await child.killAndReap(5_000);
  expect(await snapshot(root)).toEqual([]);
});
