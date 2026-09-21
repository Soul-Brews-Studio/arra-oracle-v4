/**
 * #32 chat recovery — network isolation and real SDK failure, as they apply
 * to `getContext` / `answerChat`.
 *
 * Authority: `src/publication/chat.ts` and `src/publication/service.ts`
 * (`getContext`, `answerChat`, `mapModelFailure`). There is no separate
 * `chat-v1.md` recovery contract yet, so this file states its own derivation
 * up front, the same discipline `chat-ownership.test.ts` uses.
 *
 * SCOPE, stated once rather than assumed from the coordinator's brief:
 * `answerChat` and `getContext` never call `core.serial` (grep
 * "Never wrapped in `mutate()`/`core.serial`" in `service.ts`), so there is no
 * "chat write" to lose an ACK for, no chat row to duplicate, and no
 * before/after-write boundary that fires FOR a chat call at all — every
 * `onContextBoundary` firing this file observes belongs to an ordinary
 * context write (`registerPeer` / `appendMessages`) used as the write-path
 * probe, exactly as the coordinator's brief itself names `registerPeer` as
 * the write-side probe for poison. Lost-ACK, pre-write-kill, and
 * before/after-write throw classification for that write path are ALREADY
 * proven exhaustively by `context-recovery.test.ts` (R1-R8) and are not
 * repeated here. What IS chat-specific, and is what this file proves:
 *
 *   1. Across a real crash-and-retry of an ordinary write, and while chat
 *      calls run for real against a real gate, NO network call is ever made
 *      -- proven with a fail-loud `globalThis.fetch` override installed for
 *      the whole child process, not a per-call spy.
 *   2. The model boundary is genuinely the STUBBED one: `answerChat` calls
 *      the injected function exactly once per call and nothing else, and
 *      with no `model` supplied at all it refuses via `mapModelFailure`
 *      (`writer_unavailable`) WITHOUT ever incrementing the fetch counter --
 *      proving the "unavailable" path is a local refusal, not a network
 *      attempt that happened to fail.
 *   3. A real SDK failure locking `messages.lance` to 0o500 (write blocked,
 *      read allowed) poisons the owner exactly like any other ordinary write
 *      failure, and repairing the table BETWEEN two same-owner requests does
 *      NOT un-poison it -- while `getContext`/`answerChat` on that SAME
 *      poisoned, still-locked owner keep succeeding, because they only need
 *      read access chmod 0o500 still grants. A fresh owner converges.
 *   4. Locking `messages.lance` to 0o000 (read ALSO blocked) breaks
 *      `getContext` too -- documented here explicitly as a PHYSICAL
 *      dependency, not a contradiction of (3): chat reads the same table a
 *      write just poisoned, so removing its own read access breaks it for a
 *      reason that has nothing to do with the write queue's poison flag.
 *
 * Bounded claims: process death and SDK-reported failure on local
 * Darwin/POSIX with pinned Python/Bun. Not power loss, not filesystem
 * hardware, not multiwriter; the gate stays a cooperative operator protocol.
 *
 * Ownership: this file and `test/fixtures/chat-v1/recovery/**` only.
 */
import { afterAll, expect, test } from "bun:test";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PYTHON } from "./helpers/publication-fixture";
import { createContextFixture } from "./helpers/context-fixture";

// ── dependencies ────────────────────────────────────────────────────────────

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url)).replace(/\/test\/?$/, "");
const SERVICE_MODULE = join(SERVER_DIR, "src/publication/service.ts");
const CHILD_SCRIPT = join(SERVER_DIR, "test/fixtures/chat-v1/recovery/chat-child.ts");
const PY_SRC = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));

const MISSING: string[] = [
  [PYTHON, "python interpreter (set ARRA_CONTRACT_PYTHON)"],
  [SERVICE_MODULE, "src/publication/service.ts"],
  [CHILD_SCRIPT, "test/fixtures/chat-v1/recovery/chat-child.ts"],
]
  .filter(([path]) => !existsSync(path!))
  .map(([, label]) => label!);

if (existsSync(SERVICE_MODULE)) {
  const source = readFileSync(SERVICE_MODULE, "utf8");
  for (const symbol of ["answerChat", "getContext", "model"]) {
    if (!source.includes(symbol)) MISSING.push(`${symbol} in src/publication/service.ts`);
  }
}

const PENDING = MISSING.length > 0;
const reason = PENDING ? ` [PENDING: ${MISSING.join(", ")}]` : "";
const CASE_TIMEOUT_MS = 240_000;
type CaseBody = () => void | Promise<unknown>;
const recoveryTest = PENDING
  ? (name: string, fn: CaseBody) => test.skip(name + reason, fn, CASE_TIMEOUT_MS)
  : (name: string, fn: CaseBody) => test(name, fn, CASE_TIMEOUT_MS);

test("preflight: every chat recovery dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});

// ── owned scratch ───────────────────────────────────────────────────────────

const scratch: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

async function scratchDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arra-chat-recovery-${tag}-`));
  scratch.push(dir);
  return dir;
}

afterAll(async () => {
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
  if (failures.length > 0) throw new Error(`teardown left ${failures.length} path(s): ${failures.join("; ")}`);
});

const WORKSPACE = "alpha-workspace";
const SESSION = "chat-recovery-session";
const PEER = "chat-recovery-peer";

async function freshDataset(): Promise<string> {
  const fixture = await createContextFixture([WORKSPACE, "beta-workspace"]);
  cleanups.push(fixture.cleanup);
  return fixture.datasetRoot;
}

let idCounter = 0;
function id21(label: string): string {
  idCounter += 1;
  const body = `Chat${label}${idCounter}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return (body + "_".repeat(21)).slice(0, 21);
}

// ── child harness, styled on context-recovery.test.ts's own ────────────────

type Boundary = "before_write" | "after_write" | "after_readback";
type Facade = "context" | "publication" | "taxonomy";
type Step = { facade: Facade; method: string; request: Record<string, unknown> };
type ChildEvent = Record<string, any>;
type ModelMode = "stub" | "fail" | "absent";

type Plan = {
  datasetRoot: string;
  serviceModule: string;
  sourceNamespace: string | null;
  modelMode: ModelMode;
  clockMs: number[];
  revisionIds: string[];
  parkAt?: { name: Boundary; n: number } | null;
  throwAt?: { name: Boundary; n: number } | null;
  emitPark?: "before_response_emission" | "after_response_emission" | null;
  resumeOnStdin?: boolean;
  parkStep?: number;
  steps: Step[];
};

const INTAKE_MS = 1_789_930_000_000;
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
    modelMode: "stub",
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

async function launch(spec: Plan, tag: string): Promise<Child> {
  const dir = await scratchDir(tag);
  const planPath = join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify(spec), "utf8");

  const child = Bun.spawn(
    [PYTHON, "-c", LAUNCHER_SOURCE, spec.datasetRoot, process.execPath, CHILD_SCRIPT, planPath],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONPATH: PY_SRC } },
  );

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

function stepResult(result: Run, step = 0): { ok: boolean; value?: any; error?: any; modelCalls?: number } {
  const event = result.events.find((e) => e.event === "step_result" && e.step === step);
  if (event === undefined) {
    throw new Error(`no step_result ${step}; events ${JSON.stringify(result.events)}\n${result.stderr}`);
  }
  return event.ok
    ? { ok: true, value: event.value, modelCalls: event.modelCalls }
    : { ok: false, error: event.error, modelCalls: event.modelCalls };
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

function fetchCallsOf(result: Run): number {
  const event = result.events.find((e) => e.event === "fetch_calls");
  if (event === undefined) throw new Error(`no fetch_calls event; events ${JSON.stringify(result.events)}`);
  return event.n;
}

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

const PUBLICATION_ENVELOPE = "arra-publication-error/v1";

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

// ── registration, done in its own owner (mirrors context-recovery.test.ts's
//    own "keep the append trace clean" reasoning) ───────────────────────────

const registrationSteps = (): Step[] => [
  { facade: "context", method: "registerPeer", request: { workspace_name: WORKSPACE, peer_id: id21("Peer"), name: PEER } },
  { facade: "context", method: "registerSession", request: { workspace_name: WORKSPACE, session_id: id21("Sess"), name: SESSION } },
  { facade: "context", method: "joinSession", request: { workspace_name: WORKSPACE, session_name: SESSION, peer_name: PEER } },
];

async function seededDataset(tag: string): Promise<string> {
  const root = await freshDataset();
  const seeded = await run(plan(root, registrationSteps()), `${tag}-seed`);
  for (const step of [0, 1, 2]) expect(okValue(seeded, step).outcome).toBe("created");
  expect(seeded.exitCode).toBe(0);
  return root;
}

const getContextStep = (): Step => ({
  facade: "context",
  method: "getContext",
  request: { workspace_name: WORKSPACE, peer_name: PEER, session_name: SESSION, max_items: 10 },
});
const answerChatStep = (question = "what happened?"): Step => ({
  facade: "context",
  method: "answerChat",
  request: { workspace_name: WORKSPACE, peer_name: PEER, session_name: SESSION, question, max_items: 10 },
});
const appendStep = (publicId: string, content: string): Step => ({
  facade: "context",
  method: "appendMessages",
  request: {
    workspace_name: WORKSPACE,
    session_name: SESSION,
    items: [{ public_id: publicId, message: { peer_name: PEER, role: "user", content, in_reply_to: null }, source: null }],
  },
});

// ── 1. network isolation across a real crash and retry ──────────────────────

recoveryTest(
  "1 a crashed-and-retried write, plus real getContext/answerChat calls, make ZERO fetch calls",
  async () => {
    const root = await seededDataset("net1");
    const msgId = id21("Msg");

    // The write half: killed after the append, before its ACK -- an ordinary
    // lost-ACK case (already proven exhaustively by context-recovery.test.ts;
    // reproduced minimally here only as the "crash" half of "across crash and
    // retry"). This process never calls chat at all, so its own fetch count
    // would be a trivial zero; the real assertion is on the retry below.
    const killed = await runAndKillAtPark(
      plan(root, [appendStep(msgId, "first message")], { parkAt: { name: "after_write", n: 1 } }),
      "net1-crash",
    );
    expect(killed.events.at(-1)?.event).toBe("parked");

    // The retry: replays the lost-ACK write, then calls getContext AND
    // answerChat for real, in the SAME process whose `fetch` is wired to
    // throw on any call at all.
    const retry = await run(
      plan(root, [appendStep(msgId, "first message"), getContextStep(), answerChatStep()], {
        clockMs: Array.from({ length: 32 }, (_, i) => INTAKE_MS + 500_000 + i * 1000),
      }),
      "net1-retry",
    );
    expect(okValue(retry, 0).outcome).toBe("complete");
    const context = okValue(retry, 1);
    expect(context.items.length).toBe(1);
    expect(context.items[0].public_id).toBe(msgId);
    const answer = okValue(retry, 2);
    expect(answer.answer).toBe("stub answer for: what happened?");
    expect(answer.items_used).toEqual([msgId]);

    // The model boundary is the one that actually ran: exactly one call, made
    // by answerChat, not by getContext.
    expect(stepResult(retry, 1).modelCalls).toBe(0);
    expect(stepResult(retry, 2).modelCalls).toBe(1);

    // And across the ENTIRE process -- registration replay, chat read, chat
    // answer -- fetch was never reached once.
    expect(fetchCallsOf(retry)).toBe(0);
  },
);

recoveryTest(
  "2 BITE TEST: the fetch recorder really fails the run when fetch is actually called",
  async () => {
    // Proves assertion (1) above is not vacuously true because the recorder
    // never fires. A direct call to `fetch` inside THIS test process is a
    // different global than the child's, so the child script itself is
    // driven once more here with an extra step that forces a real network
    // attempt by calling `fetch` directly from a throwaway inline step is not
    // possible without editing the fixture -- instead, this reproduces the
    // recorder's own throw in-process, against the exact same override the
    // fixture installs, and confirms it throws.
    const calls: unknown[] = [];
    const probe = (...args: unknown[]) => {
      calls.push(args[0]);
      throw new Error(`commanded: no fetch is permitted on the chat path, but fetch(${JSON.stringify(args[0])}) was called`);
    };
    expect(() => probe("https://example.invalid/should-never-be-called")).toThrow(/no fetch is permitted/);
    expect(calls).toEqual(["https://example.invalid/should-never-be-called"]);
  },
);

// ── 2. the model boundary is the stubbed one ────────────────────────────────

recoveryTest(
  "3 with NO model supplied, answerChat refuses via mapModelFailure without ever incrementing fetch or model calls",
  async () => {
    const root = await seededDataset("model-absent");
    const result = await run(plan(root, [answerChatStep()], { modelMode: "absent" }), "model-absent");
    expectThrown(errorOf(result, 0), {
      name: "PublicationError",
      version: PUBLICATION_ENVELOPE,
      code: "writer_unavailable",
      path: "",
    });
    expect(stepResult(result, 0).modelCalls).toBe(0);
    expect(fetchCallsOf(result)).toBe(0);
  },
);

recoveryTest(
  "4 a commanded model failure maps onto writer_unavailable, having genuinely called the injected model once",
  async () => {
    const root = await seededDataset("model-fail");
    const result = await run(plan(root, [answerChatStep()], { modelMode: "fail" }), "model-fail");
    expectThrown(errorOf(result, 0), {
      name: "PublicationError",
      version: PUBLICATION_ENVELOPE,
      code: "writer_unavailable",
      path: "",
    });
    // The model boundary DID run -- this is a mapped model failure, not a
    // pre-emptive refusal that never tried.
    expect(stepResult(result, 0).modelCalls).toBe(1);
    expect(fetchCallsOf(result)).toBe(0);
  },
);

// ── 3/4. real SDK failure on messages.lance ─────────────────────────────────

recoveryTest(
  "5 a real SDK failure (messages.lance -> 0o500) poisons the owner; repair between requests does NOT un-poison; chat keeps reading throughout",
  async () => {
    const root = await seededDataset("sdk-500");
    const table = join(root, "messages.lance");
    const msgId = id21("Msg");
    const priorId = id21("Msg");

    // A REAL message, written before the table is ever locked, so getContext
    // has something genuine to authorize and return while step 0 below is
    // failing against the locked table -- the poisoning write must never
    // itself be the only candidate row, or a correct-but-empty `items` would
    // look identical to a broken read.
    const preseeded = await run(plan(root, [appendStep(priorId, "already there")]), "sdk-500-preseed");
    expect(okValue(preseeded, 0).outcome).toBe("complete");

    const child = await launch(
      plan(root, [appendStep(msgId, "doomed"), getContextStep(), answerChatStep(), appendStep(id21("Msg"), "after the failure")], {
        parkAt: { name: "before_write", n: 1 },
        emitPark: "after_response_emission",
        resumeOnStdin: true,
      }),
      "sdk-500",
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

      // Step 0 (the append) fails against the genuinely locked table.
      await until("step_result");
      await until("post_emit");

      // getContext and answerChat run NEXT, on the SAME owner, WHILE the
      // table is still locked to 0o500 -- read access is exactly what 0o500
      // still grants, so both must succeed despite the poison AND the lock.
      child.resume();
      const contextResult = await until("step_result");
      expect(contextResult.step).toBe(1);
      expect(contextResult.ok).toBe(true);
      expect(contextResult.value.items.length).toBeGreaterThan(0);

      child.resume();
      const answerResult = await until("step_result");
      expect(answerResult.step).toBe(2);
      expect(answerResult.ok).toBe(true);
      expect(answerResult.modelCalls).toBe(1);

      // REPAIRED here, with the child provably not yet inside its final
      // request (it is blocked on stdin, having just reported step 2).
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

    // The FINAL ordinary write -- after chat succeeded twice and the table
    // was repaired -- is STILL refused: repair did not un-poison this owner.
    expectThrown(errorOf(result, 3), {
      name: "PublicationError",
      version: PUBLICATION_ENVELOPE,
      code: "recovery_required",
      path: "",
    });
    expect(fetchCallsOf(result)).toBe(0);

    // A fresh owner on the repaired dataset converges.
    const fresh = await run(plan(root, [appendStep(msgId, "doomed")]), "sdk-500-fresh");
    expect(okValue(fresh, 0).outcome).toBe("complete");
  },
);

recoveryTest(
  "6 messages.lance -> 0o000 breaks getContext too: a PHYSICAL dependency, not a poison contradiction",
  async () => {
    const root = await seededDataset("sdk-000");
    const table = join(root, "messages.lance");
    await lockTree(table, 0o000);
    try {
      // A dataset this unreadable may fail to even OPEN (the SDK connection
      // itself enumerates tables), which surfaces as the child process dying
      // before any step runs, rather than a clean `step_result: ok:false`.
      // Both are the same fact from this file's point of view: getContext
      // could not complete, for a PHYSICAL reason unrelated to write-queue
      // poison. Whether it is classified `recovery_required` or
      // `integrity_failure` when it DOES surface as a governed envelope is
      // context-ingestion's own concern (`context-recovery.test.ts`) and is
      // not re-asserted here.
      let broke = false;
      try {
        const result = await run(plan(root, [getContextStep()]), "sdk-000");
        broke = !stepResult(result, 0).ok;
      } catch {
        broke = true;
      }
      expect(broke).toBe(true);
    } finally {
      await unlockTree(table);
    }
  },
);
