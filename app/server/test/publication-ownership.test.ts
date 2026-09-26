// #26 ownership evidence — writer exclusion, descriptor identity, single owner,
// dataset-shape gating, close lifetime and facade shape.
//
// Authority is `app/docs/contracts/revision-publication-v1.md`
// (SHA256 387272dc8655319f877ef2bb4926caf0127c3712373b1309084e2d00172a9f9c, which
// supersedes 257ca098…) §3, §9 and §11. Publication semantics (§2, §4–§6) belong to
// `publication-service.test.ts` and crash reconstruction (§7–§8) to
// `publication-recovery.test.ts`; nothing here asserts acceptance or ancestry.
//
// How contention is proved, and why it is not the exit code. A child that dies
// for an unrelated reason also exits nonzero, so every case reads NAMED EVENT
// STRINGS the child prints at labelled boundaries, and asserts both the event
// that must appear and the one that must not — a refusal is evidence of
// exclusion-before-connect only if `connect:attempted` never printed. Every
// refusal is paired with a positive control on the same harness: the identical
// command succeeds once the blocking owner is gone. Without that control, a
// refusal assertion would also pass against a child that never worked at all.
//
// Shared machinery comes from `helpers/publication-fixture.ts`: the seeded
// target19 dataset, the gated-child launchers and the valid 21-key envelope
// builder. This file adds only what it needs beyond them — ungated probes that
// hold or contend for the gate, and a multi-event line reader.
//
// Bounded claims, stated rather than implied:
//
// * The gate is a COOPERATIVE local protocol inside a trusted operator boundary.
//   These tests say nothing about same-UID code that imports the SDK and
//   declines to ask, about Linux, NFS or R2, or about multiwriter CAS.
//   Measured on Darwin with Bun 1.3.14; the contract's product interpreter is
//   Python 3.12.13.
// * A descriptor check proves descriptor IDENTITY, not that its holder owns the
//   flock. §3 says so: the environment fields LOCATE the descriptor, and correct
//   launcher participation is part of the local operator TCB. The mislabelled-
//   descriptor probe tests the identity check it can test, and nothing more.
// * Lock release on process death is kernel behaviour observed for owned PIDs
//   killed and reaped by this parent. It is not a power-loss guarantee.
//
// Interpreter: `ARRA_CONTRACT_PYTHON`, the same variable the existing
// cross-language tests use, must point at an interpreter that can import
// `lancedb` (a worktree has no `.venv` of its own). Suites needing the real
// dataset name that blocker in their title and skip when it is unavailable, so a
// missing environment never reads as a pass.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Fixture,
  type GatedChild,
  PYTHON,
  createFixture,
  runGated,
  spawnGatedChild,
} from "./helpers/publication-fixture";
import { scaledMs } from "./helpers/timing.scaledMs";
import { testTimeout } from "./helpers/timing.testTimeout";

/** Contract §3 literals, taken from the contract rather than from the source. */
const LOCK_FILENAME = ".arra-writer.lock";
const INHERITED_FD = 42;

const SERVER_DIR = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(SERVER_DIR, "..", "..");
const PY_SRC = join(REPO_ROOT, "app", "migrate-py", "src");
/** §11: the only publication entrypoints live here. */
const SERVICE_MODULE = join(SERVER_DIR, "src", "publication", "service.ts");
const HELPER_MODULE = join(import.meta.dir, "helpers", "publication-fixture.ts");

/** Parent-enforced ceiling on every child. No child outlives its test. */
const CHILD_DEADLINE_MS = scaledMs(30_000);
const TEST_TIMEOUT_MS = testTimeout(120_000);

/** Deterministic operator injections (§9 fault-test seam). Never request data. */
const FIXED_REVISION_ID = "a".repeat(21);
const FIXED_CLOCK_MS = 1_789_905_600_000;
/** A well-formed but absent node: reads must answer exactly `null` (§2). */
const ABSENT_NODE_ID = "b".repeat(21);
const FIXTURE_WORKSPACE = "alpha-workspace";

// ── ungated child harness ────────────────────────────────────────────────────
//
// The helper owns gated children; these are the ones that must NOT be gated —
// gate holders, contenders, readers and an unwrapped writer.

type Child = {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  events: string[];
  waitForEvent(name: string, timeoutMs?: number): Promise<string>;
  stop(): Promise<void>;
};

/** Children this parent owns. Killed by exact PID and reaped after every test. */
const live = new Set<Child>();

function pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): void {
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk as Uint8Array, { stream: true });
      let cut = buffered.indexOf("\n");
      while (cut !== -1) {
        onLine(buffered.slice(0, cut));
        buffered = buffered.slice(cut + 1);
        cut = buffered.indexOf("\n");
      }
    }
    if (buffered.length > 0) onLine(buffered);
  })().catch(() => {
    // A closed pipe after the owner was killed is the expected end of stream.
  });
}

function spawnChild(cmd: string[], env: Record<string, string> = {}): Child {
  const proc = Bun.spawn({
    cmd,
    env: { ...process.env, PYTHONPATH: PY_SRC, ...env } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }) as Bun.Subprocess<"ignore", "pipe", "pipe">;

  const events: string[] = [];
  const waiters: { name: string; resolve: (line: string) => void }[] = [];

  const record = (line: string) => {
    if (!line.startsWith("EVENT ")) return;
    const event = line.slice("EVENT ".length).trim();
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i]!;
      if (event === waiter.name || event.startsWith(`${waiter.name} `)) {
        waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  };

  pump(proc.stdout, record);
  pump(proc.stderr, record);

  // The deadline is the PARENT's: a child that hangs is killed by PID here
  // rather than being trusted to time itself out.
  const deadline = setTimeout(() => {
    proc.kill("SIGKILL");
  }, CHILD_DEADLINE_MS);

  const child: Child = {
    proc,
    events,
    waitForEvent(name: string, timeoutMs = CHILD_DEADLINE_MS) {
      const already = events.find((event) => event === name || event.startsWith(`${name} `));
      if (already !== undefined) return Promise.resolve(already);
      return new Promise<string>((resolveWaiter, rejectWaiter) => {
        const timer = setTimeout(() => {
          rejectWaiter(new Error(`child never emitted "${name}"; saw ${JSON.stringify(events)}`));
        }, timeoutMs);
        waiters.push({
          name,
          resolve: (line) => {
            clearTimeout(timer);
            resolveWaiter(line);
          },
        });
      });
    },
    async stop() {
      clearTimeout(deadline);
      // Exact owned PID, never a pattern, and always reaped.
      proc.kill("SIGKILL");
      await proc.exited;
      live.delete(child);
    },
  };

  live.add(child);
  return child;
}

/** Run an ungated child to completion under the parent deadline. */
async function runChild(cmd: string[], env: Record<string, string> = {}) {
  const child = spawnChild(cmd, env);
  try {
    const exitCode = await child.proc.exited;
    // Let the stream pump drain what the child wrote just before exiting.
    await new Promise((r) => setTimeout(r, 25));
    return { exitCode, events: [...child.events] };
  } finally {
    await child.stop();
  }
}

/** Gated children come from the helper; these read their event stream. */
const eventsOf = (stdout: string): string[] =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("EVENT "))
    .map((line) => line.slice("EVENT ".length).trim());

/** Read a live gated child's lines until a named event arrives. */
async function readUntil(child: GatedChild, name: string, seen: string[]): Promise<string> {
  for (;;) {
    const line = await child.nextLine(CHILD_DEADLINE_MS);
    if (!line.startsWith("EVENT ")) continue;
    const event = line.slice("EVENT ".length).trim();
    seen.push(event);
    if (event === name || event.startsWith(`${name} `)) return event;
  }
}

/** The single event with the given prefix, so a missing one fails loudly. */
const eventFor = (events: string[], name: string): string =>
  events.find((event) => event === name || event.startsWith(`${name} `)) ??
  `MISSING ${name} (saw ${JSON.stringify(events)})`;

// ── inline child probes ──────────────────────────────────────────────────────
//
// Written into the harness's own temporary directory, never into the source
// tree. Each prints named boundary markers and nothing else.

const scripts = mkdtempSync(join(tmpdir(), "arra-v4-ownership-scripts-"));
const scriptPath = (name: string) => join(scripts, name);

/** Holds the gate until killed, or until its own bounded hold expires. */
const HOLD_PY = `import sys, time
from arra_migrate.writer_gate import writer_gate

root, hold_seconds = sys.argv[1], float(sys.argv[2])
with writer_gate(root):
    print("EVENT gate:acquired", flush=True)
    time.sleep(hold_seconds)
print("EVENT gate:released", flush=True)
`;

/**
 * Contends for the gate. `connect:attempted` prints only INSIDE the gate, so
 * its absence is what proves refusal preceded any writable connect.
 */
const CONTEND_PY = `import sys
from arra_migrate.writer_gate import UnsupportedDatasetError, WriterUnavailableError, writer_gate

root = sys.argv[1]
try:
    with writer_gate(root):
        print("EVENT gate:acquired", flush=True)
        print("EVENT connect:attempted", flush=True)
except WriterUnavailableError as error:
    print("EVENT gate:refused " + error.code, flush=True)
except UnsupportedDatasetError as error:
    print("EVENT gate:unsupported " + error.code, flush=True)
`;

/**
 * A launcher that hands over fd 42 on an UNRELATED file plus a right-looking
 * environment, without ever taking the gate. The probe for descriptor identity;
 * not a claim that flock holding itself is verifiable from the descriptor.
 */
const HOSTILE_PY = `import os, sys

decoy, root, argv = sys.argv[1], sys.argv[2], sys.argv[3:]
fd = os.open(decoy, os.O_RDWR | os.O_CREAT, 0o600)
os.dup2(fd, ${INHERITED_FD}, inheritable=True)
env = dict(os.environ)
env["ARRA_WRITER_FD"] = "${INHERITED_FD}"
env["ARRA_WRITER_ROOT"] = os.path.realpath(root)
os.execvpe(argv[0], argv, env)
`;

/** Table names, row counts and table versions — a read-only observation. */
const COUNT_PY = `import json, sys
import lancedb

db = lancedb.connect(sys.argv[1])
state = {}
for name in sorted(db.table_names()):
    table = db.open_table(name)
    state[name] = {"rows": table.count_rows(), "version": table.version}
print("EVENT dataset:state " + json.dumps(state, sort_keys=True), flush=True)
`;

/**
 * Drift a copied dataset under the gate, the way any other writer must.
 *
 * `drop` removes a table outright; `retype` rebuilds one with a single field's
 * type changed, which name-only verification would accept and full schema
 * verification must not. The schema is read from the live table, so the drift is
 * relative to what is actually there rather than to a second copy of the golden.
 */
const DRIFT_PY = `import sys
import lancedb
import pyarrow as pa
from arra_migrate.writer_gate import writer_gate

root, mode, table_name = sys.argv[1], sys.argv[2], sys.argv[3]
with writer_gate(root):
    db = lancedb.connect(root)
    schema = db.open_table(table_name).schema
    db.drop_table(table_name)
    if mode == "retype":
        fields = list(schema)
        index = next(i for i, f in enumerate(fields) if not pa.types.is_string(f.type))
        fields[index] = pa.field(fields[index].name, pa.string(), fields[index].nullable)
        db.create_table(table_name, schema=pa.schema(fields))
print("EVENT drift:applied " + mode + " " + table_name, flush=True)
`;

/** Opens a publication writer for argv[2] through the §11 entrypoint. */
const WRITER_TS = `import { openPublicationWriter } from ${JSON.stringify(SERVICE_MODULE)};

const root = process.argv[2];
const holdMs = Number(process.argv[3] ?? "0");
try {
  const service = await openPublicationWriter(root, {
    newRevisionId: () => ${JSON.stringify(FIXED_REVISION_ID)},
    clock: () => ${FIXED_CLOCK_MS},
  });
  console.log("EVENT writer:ready");
  // §2, §11: the facade carries exactly the contracted methods, and nothing
  // reachable on it is a raw table, connection or owner handle.
  console.log(\`EVENT writer:surface \${Object.keys(service).sort().join(",")}\`);
  const values = [...new Set(Object.values(service).map((value) => typeof value))].sort();
  console.log(\`EVENT writer:valuetypes \${values.join(",")}\`);
  console.log(\`EVENT writer:prototype \${Object.getPrototypeOf(service) === Object.prototype}\`);
} catch (error) {
  console.log(\`EVENT writer:refused \${(error as { code?: string }).code ?? "no-code"}\`);
}
// Staying alive keeps THIS process's inherited descriptor — and so the gate —
// held, which is what a contender must run against.
if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
`;

/** Single-owner probe, run inside ONE gated process. */
const OWNERS_TS = `import { openPublicationWriter } from ${JSON.stringify(SERVICE_MODULE)};

const [, , root, alias] = process.argv;
const options = {
  newRevisionId: () => ${JSON.stringify(FIXED_REVISION_ID)},
  clock: () => ${FIXED_CLOCK_MS},
};
const codeOf = (error: unknown) => (error as { code?: string }).code ?? "no-code";
const attempt = (target: string) =>
  openPublicationWriter(target, options).then(
    () => "ready",
    (error: unknown) => codeOf(error),
  );

const first = await openPublicationWriter(root, options);
console.log("EVENT owner:first ready");
// A second owner inside one process. Both opens would be validating the SAME
// inherited descriptor — one open file description, already held — so the
// descriptor check cannot separate them and only the registry can.
console.log(\`EVENT owner:second \${await attempt(root)}\`);
// The alias names the same dataset; canonical identity must collide too.
console.log(\`EVENT owner:alias \${await attempt(alias)}\`);

const request = new TextEncoder().encode(
  JSON.stringify({ workspace_name: ${JSON.stringify(FIXTURE_WORKSPACE)}, node_id: ${JSON.stringify(ABSENT_NODE_ID)} }),
);
console.log(\`EVENT owner:read \${JSON.stringify(await first.getAcceptedHead(request))}\`);

await first.close();
console.log("EVENT owner:closed");
console.log(
  \`EVENT owner:readafterclose \${await first.getAcceptedHead(request).then(() => "served", codeOf)}\`,
);
// Closing released the inherited descriptor, so this process no longer holds a
// gate. §3 requires a held descriptor before EVERY open, which makes reopening
// from here a refusal rather than a convenience: the registry slot being free
// is necessary, never sufficient.
console.log(\`EVENT owner:reopen \${await attempt(root)}\`);
`;

/**
 * Close lifetime, orchestrated through the §9 boundary seam.
 *
 * One publish parks at `before_append`; a second is queued behind it; then
 * `close()` is called. §3 requires close to wait for the IN-FLIGHT request,
 * reject the QUEUED one, and release the fd — after which another process may
 * acquire the gate even though this process is still alive.
 */
const CLOSE_TS = `import { openPublicationWriter } from ${JSON.stringify(SERVICE_MODULE)};
import { encodeRequest, idSource, revisionEnvelope } from ${JSON.stringify(HELPER_MODULE)};

const [, , root, seededJson, workspace, holdArg] = process.argv;
const seeded = JSON.parse(seededJson!);
const holdMs = Number(holdArg ?? "0");
const codeOf = (error: unknown) => (error as { code?: string }).code ?? "no-code";
const settled = (promise: Promise<unknown>) =>
  promise.then(
    (value) => \`resolved:\${(value as { outcome?: string }).outcome ?? "no-outcome"}\`,
    (error: unknown) => \`rejected:\${codeOf(error)}\`,
  );

const deferred = () => {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolveDeferred) => {
    settle = resolveDeferred;
  });
  return { promise, resolve: () => settle?.() };
};

// The first request parks here; the parent learns about it from the event, and
// the child itself decides when to let it go.
const parked = deferred();
const resume = deferred();
let alreadyParked = false;

const service = await openPublicationWriter(root, {
  newRevisionId: idSource("own"),
  clock: () => ${FIXED_CLOCK_MS},
  onBoundary: async (boundary) => {
    if (boundary !== "before_append" || alreadyParked) return;
    alreadyParked = true;
    console.log(\`EVENT boundary:\${boundary}\`);
    parked.resolve();
    await resume.promise;
    console.log("EVENT boundary:resumed");
  },
});

const publish = (operation: string, nodeId: string) =>
  service.publishRevision(
    encodeRequest({ operation_id: operation, content: revisionEnvelope(workspace!, seeded, nodeId) }),
  );

const inFlight = publish("ownership-in-flight", "c".repeat(21));
await parked.promise;
// Enqueued while the first request is parked INSIDE the queue, so it is queued
// work by construction rather than by timing luck.
const queued = publish("ownership-queued", "d".repeat(21));
console.log("EVENT close:called");
const closing = service.close();
// Hand the parked request back its turn; close must wait for exactly this one.
resume.resolve();

console.log(\`EVENT inflight \${await settled(inFlight)}\`);
console.log(\`EVENT queued \${await settled(queued)}\`);
console.log(
  \`EVENT close \${await closing.then(() => "resolved", (error: unknown) => \`rejected:\${codeOf(error)}\`)}\`,
);
// Still alive, deliberately: §3 says the fd is released by CLOSE, so a separate
// process must be able to acquire the gate from here without this one dying.
console.log("EVENT owner:alive");
if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
`;

/** Reader probe: no gate, no mutator, exact scoped surface. */
const READER_TS = `import { openPublicationReader } from ${JSON.stringify(SERVICE_MODULE)};

const root = process.argv[2];
try {
  const reader = await openPublicationReader(root);
  console.log("EVENT reader:ready");
  console.log(\`EVENT reader:surface \${Object.keys(reader).sort().join(",")}\`);
  console.log(\`EVENT reader:prototype \${Object.getPrototypeOf(reader) === Object.prototype}\`);
  const values = [...new Set(Object.values(reader).map((value) => typeof value))].sort();
  console.log(\`EVENT reader:valuetypes \${values.join(",")}\`);
  const request = new TextEncoder().encode(
    JSON.stringify({ workspace_name: ${JSON.stringify(FIXTURE_WORKSPACE)}, node_id: ${JSON.stringify(ABSENT_NODE_ID)} }),
  );
  console.log(\`EVENT reader:read \${JSON.stringify(await reader.getAcceptedHead(request))}\`);
} catch (error) {
  console.log(\`EVENT reader:refused \${(error as { code?: string }).code ?? "no-code"}\`);
}
`;

writeFileSync(scriptPath("hold.py"), HOLD_PY, { mode: 0o600 });
writeFileSync(scriptPath("contend.py"), CONTEND_PY, { mode: 0o600 });
writeFileSync(scriptPath("hostile.py"), HOSTILE_PY, { mode: 0o600 });
writeFileSync(scriptPath("count.py"), COUNT_PY, { mode: 0o600 });
writeFileSync(scriptPath("drift.py"), DRIFT_PY, { mode: 0o600 });
writeFileSync(scriptPath("writer.ts"), WRITER_TS, { mode: 0o600 });
writeFileSync(scriptPath("owners.ts"), OWNERS_TS, { mode: 0o600 });
writeFileSync(scriptPath("close.ts"), CLOSE_TS, { mode: 0o600 });
writeFileSync(scriptPath("reader.ts"), READER_TS, { mode: 0o600 });

// ── dataset scratch ──────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "arra-v4-ownership-data-"));

/** A fresh, owned, empty dataset directory. Never an existing dataset. */
function newDataset(name: string): string {
  const root = join(scratch, name);
  Bun.spawnSync(["mkdir", "-p", root]);
  return root;
}

/**
 * The reference target19 dataset, built once through the accepted creator.
 *
 * Never mutated: every test that drifts a dataset works on its own copy. A
 * failure here (typically an interpreter that cannot import LanceDB) leaves the
 * dataset-dependent suites skipped and named, never green.
 */
const fixture: Fixture | null = await createFixture([FIXTURE_WORKSPACE, "beta-workspace"]).catch(
  () => null,
);
const FIXTURE_READY = fixture !== null;
const PENDING_FIXTURE = `needs a target19 fixture — set ARRA_CONTRACT_PYTHON to an interpreter with lancedb`;

/** A private copy of the reference dataset, safe for a test to drift. */
function copyFixture(name: string): string {
  const root = join(scratch, name);
  const copied = Bun.spawnSync(["cp", "-R", fixture!.datasetRoot, root]);
  expect(copied.exitCode).toBe(0);
  return root;
}

/** Table names, row counts and versions, observed without the service. */
async function datasetState(root: string): Promise<string> {
  const run = await runChild([PYTHON, scriptPath("count.py"), root]);
  return eventFor(run.events, "dataset:state");
}

/** Create the lock file without holding it, by taking and releasing the gate. */
async function primeLock(root: string): Promise<void> {
  const run = await runChild([PYTHON, scriptPath("hold.py"), root, "0"]);
  expect(run.events).toContain("gate:acquired");
}

const lockStat = (root: string) => {
  const info = statSync(join(root, LOCK_FILENAME));
  return { dev: info.dev, ino: info.ino, nlink: info.nlink, mode: info.mode, uid: info.uid };
};

afterEach(async () => {
  // Nothing owned by a finished test is allowed to survive it.
  for (const child of [...live]) await child.stop();
});

afterAll(async () => {
  rmSync(scripts, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  await fixture?.cleanup();
});

// ── A. writer exclusion happens before connect ───────────────────────────────

describe("writer exclusion before connect", () => {
  test(
    "a contender is refused before it can connect, and succeeds once the owner is gone",
    async () => {
      const root = newDataset("exclusion");
      const holder = spawnChild([PYTHON, scriptPath("hold.py"), root, "15"]);
      await holder.waitForEvent("gate:acquired");

      const contender = await runChild([PYTHON, scriptPath("contend.py"), root]);
      expect(contender.events).toContain("gate:refused writer_unavailable");
      // The whole point: refusal precedes connect, so no writable connection is
      // ever opened on a dataset this process does not own.
      expect(contender.events).not.toContain("connect:attempted");
      expect(contender.events).not.toContain("gate:acquired");

      // Positive control on the identical command: the refusal was caused by the
      // live owner, not by a contender that cannot work at all.
      await holder.stop();
      const afterRelease = await runChild([PYTHON, scriptPath("contend.py"), root]);
      expect(afterRelease.events).toContain("gate:acquired");
      expect(afterRelease.events).toContain("connect:attempted");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a refused contender mutates nothing in the dataset directory",
    async () => {
      const root = newDataset("no-mutation");
      const holder = spawnChild([PYTHON, scriptPath("hold.py"), root, "15"]);
      await holder.waitForEvent("gate:acquired");

      const before = readdirSync(root).sort();
      const contender = await runChild([PYTHON, scriptPath("contend.py"), root]);
      expect(contender.events).toContain("gate:refused writer_unavailable");

      expect(readdirSync(root).sort()).toEqual(before);
      // The lock file is the only thing this protocol creates here, and the
      // refusal added, replaced and removed nothing beside it.
      expect(before).toEqual([LOCK_FILENAME]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a Python migrator holding the gate stops a Bun writer before it can launch",
    async () => {
      const root = newDataset("python-holds");
      const holder = spawnChild([PYTHON, scriptPath("hold.py"), root, "15"]);
      await holder.waitForEvent("gate:acquired");

      const blocked = await runGated(root, scriptPath("writer.ts"), [root, "0"], {
        deadlineMs: CHILD_DEADLINE_MS,
      });
      // `exec_with_gate` refuses before exec, so the writer program never ran at
      // all: no writer event of any kind, therefore no connect.
      expect(eventsOf(blocked.stdout).some((event) => event.startsWith("writer:"))).toBe(false);
      expect(blocked.stderr).toContain("WriterUnavailableError");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── B. canonical alias contention ────────────────────────────────────────────

describe("canonical alias contention", () => {
  test(
    "every spelling of one dataset contends for one lock, while a different dataset does not",
    async () => {
      const root = newDataset("alias-real");
      const other = newDataset("alias-other");
      const aliasLink = join(scratch, "alias-symlink");
      symlinkSync(root, aliasLink);

      const spellings = [
        aliasLink,
        `${root}/`,
        `${root}/.`,
        join(root, "..", "alias-real"),
        join(aliasLink, "..", "alias-real"),
      ];

      const holder = spawnChild([PYTHON, scriptPath("hold.py"), root, "15"]);
      await holder.waitForEvent("gate:acquired");

      for (const spelling of spellings) {
        const contender = await runChild([PYTHON, scriptPath("contend.py"), spelling]);
        // Compared as a whole object so the spelling under test appears in the
        // failure message instead of an anonymous "expected true".
        expect({ spelling, events: contender.events }).toEqual({
          spelling,
          events: ["gate:refused writer_unavailable"],
        });
      }

      // Positive control: the assertions above are not "every contender is always
      // refused" — a genuinely different dataset acquires while the owner holds.
      const unrelated = await runChild([PYTHON, scriptPath("contend.py"), other]);
      expect(unrelated.events).toContain("gate:acquired");

      // One lock location, proven by inode identity rather than by path text.
      const identity = lockStat(root);
      for (const spelling of spellings) {
        expect(lockStat(spelling)).toEqual(identity);
      }
      expect(lockStat(other).ino).not.toBe(identity.ino);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a URL-shaped root is refused as an unsupported dataset, not as a busy writer",
    async () => {
      const contender = await runChild([PYTHON, scriptPath("contend.py"), "s3://bucket/dataset"]);
      expect(contender.events).toContain("gate:unsupported unsupported_dataset");
      expect(contender.events).not.toContain("connect:attempted");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── F. no lease stealing ─────────────────────────────────────────────────────

describe("no lease stealing", () => {
  test(
    "a refused contender leaves the lock file identical and never steals it",
    async () => {
      const root = newDataset("no-steal");
      const holder = spawnChild([PYTHON, scriptPath("hold.py"), root, "15"]);
      await holder.waitForEvent("gate:acquired");

      const before = lockStat(root);
      const contender = await runChild([PYTHON, scriptPath("contend.py"), root]);
      expect(contender.events).toContain("gate:refused writer_unavailable");
      // Same inode, link count, mode and owner: not unlinked, not replaced, not
      // re-created. A contender that "fixed" the file by removing it would
      // strand the live owner, which is why existence is not ownership.
      expect(lockStat(root)).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "there is no timeout lease: waiting does not make a held lock available",
    async () => {
      const root = newDataset("no-lease");
      const holder = spawnChild([PYTHON, scriptPath("hold.py"), root, "15"]);
      await holder.waitForEvent("gate:acquired");

      const first = await runChild([PYTHON, scriptPath("contend.py"), root]);
      expect(first.events).toContain("gate:refused writer_unavailable");

      await new Promise((r) => setTimeout(r, 750));
      const second = await runChild([PYTHON, scriptPath("contend.py"), root]);
      expect(second.events).toContain("gate:refused writer_unavailable");
      // Still refused while the owner lives: release is by close or by death,
      // never by expiry and never by deleting someone else's lock file.
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a clean release keeps the same lock file rather than unlinking it",
    async () => {
      const root = newDataset("clean-release");
      const holder = await runChild([PYTHON, scriptPath("hold.py"), root, "0"]);
      expect(holder.events).toContain("gate:acquired");
      expect(holder.events).toContain("gate:released");

      const after = lockStat(root);
      const next = await runChild([PYTHON, scriptPath("contend.py"), root]);
      expect(next.events).toContain("gate:acquired");
      expect(lockStat(root)).toEqual(after);
    },
    TEST_TIMEOUT_MS,
  );
});

// ── E. inherited descriptor validation ───────────────────────────────────────

describe("inherited descriptor validation", () => {
  test(
    "an ordinary unwrapped launch is refused before connect",
    async () => {
      const root = newDataset("unwrapped");
      const run = await runChild(["bun", "run", scriptPath("writer.ts"), root, "0"]);
      expect(run.events).toContain("writer:refused writer_unavailable");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "environment fields alone do not satisfy the gate",
    async () => {
      const root = newDataset("env-only");
      await primeLock(root);
      // The environment names a descriptor this process was never handed. §3:
      // these fields LOCATE the descriptor; they are not proof of ownership.
      const run = await runChild(["bun", "run", scriptPath("writer.ts"), root, "0"], {
        ARRA_WRITER_FD: String(INHERITED_FD),
        ARRA_WRITER_ROOT: root,
      });
      expect(run.events).toContain("writer:refused writer_unavailable");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a descriptor on an unrelated file is refused despite a correct-looking environment",
    async () => {
      const root = newDataset("hostile-fd");
      await primeLock(root);
      const decoy = join(scratch, "decoy-not-the-lock");
      writeFileSync(decoy, "", { mode: 0o600 });

      const run = await runChild([
        PYTHON,
        scriptPath("hostile.py"),
        decoy,
        root,
        "bun",
        "run",
        scriptPath("writer.ts"),
        root,
        "0",
      ]);
      expect(run.events).toContain("writer:refused writer_unavailable");
      // Identity is what was checked. A same-UID process holding fd 42 on the
      // CORRECT inode without the flock is outside what this can detect, and §3
      // places that in the trusted-launcher TCB rather than in the code.
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a gate taken for one dataset does not authorise a writer for another",
    async () => {
      const gated = newDataset("gate-a");
      const target = newDataset("gate-b");
      // Both datasets have a lock file, so the only difference between them is
      // WHICH one the inherited descriptor belongs to.
      await primeLock(target);

      const crossed = await runGated(gated, scriptPath("writer.ts"), [target, "0"]);
      expect(eventsOf(crossed.stdout)).toContain("writer:refused writer_unavailable");

      // Positive control: the same launch against its OWN dataset passes the
      // gate and fails later, on dataset shape — a different code entirely.
      const matched = await runGated(gated, scriptPath("writer.ts"), [gated, "0"]);
      expect(eventsOf(matched.stdout)).toContain("writer:refused unsupported_dataset");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── H. dataset shape gating, on a real target19 dataset ──────────────────────

describe.skipIf(!FIXTURE_READY)(`target dataset gating [${PENDING_FIXTURE}]`, () => {
  test(
    "a gated writer opens the target19 dataset and exposes only the contracted methods",
    async () => {
      const root = copyFixture("gating-ready");
      const run = await runGated(root, scriptPath("writer.ts"), [root, "0"]);
      const events = eventsOf(run.stdout);
      expect(events).toContain("writer:ready");
      // §2, §11: exactly the four methods plus close, every value a function,
      // an ordinary object prototype — no adapter, table or connection escapes.
      expect(eventFor(events, "writer:surface")).toBe(
        "writer:surface close,getAcceptedHead,listAcceptedHistory,listNodes,publishRevision",
      );
      expect(eventFor(events, "writer:valuetypes")).toBe("writer:valuetypes function");
      expect(eventFor(events, "writer:prototype")).toBe("writer:prototype true");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a gated Bun writer excludes the Python migrator, and its death releases the lock",
    async () => {
      const root = copyFixture("gating-holds");
      // Launched THROUGH the gate: Python locks, then execs Bun, so the
      // surviving process is the sole owner (§3 and `exec_with_gate`).
      const owner = spawnGatedChild(root, scriptPath("writer.ts"), [root, "20000"]);
      const seen: string[] = [];
      try {
        expect(await readUntil(owner, "writer:ready", seen)).toBe("writer:ready");

        const migrator = await runChild([PYTHON, scriptPath("contend.py"), root]);
        expect(migrator.events).toContain("gate:refused writer_unavailable");
        expect(migrator.events).not.toContain("connect:attempted");

        // Kernel release on owned-process death: kill the exact PID, reap it,
        // and the same contender acquires. Nothing was deleted to make it true.
        const lockBefore = lockStat(root);
        owner.kill();
        await owner.wait();
        const afterDeath = await runChild([PYTHON, scriptPath("contend.py"), root]);
        expect(afterDeath.events).toContain("gate:acquired");
        expect(lockStat(root)).toEqual(lockBefore);
      } finally {
        owner.kill();
        await owner.wait().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a dataset missing a target table is refused with nothing touched",
    async () => {
      const root = copyFixture("gating-missing-table");
      const drift = await runChild([PYTHON, scriptPath("drift.py"), root, "drop", "read_cursors"]);
      expect(drift.events).toContain("drift:applied drop read_cursors");

      const before = await datasetState(root);
      const run = await runGated(root, scriptPath("writer.ts"), [root, "0"]);
      expect(eventsOf(run.stdout)).toContain("writer:refused unsupported_dataset");
      // §9: count schema, version and rows on a rejected case rather than
      // settling for "the directory still exists".
      expect(await datasetState(root)).toBe(before);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a dataset whose column type drifted is refused, which name-only checking would miss",
    async () => {
      const root = copyFixture("gating-retyped-column");
      const drift = await runChild([PYTHON, scriptPath("drift.py"), root, "retype", "read_cursors"]);
      expect(drift.events).toContain("drift:applied retype read_cursors");

      const before = await datasetState(root);
      const run = await runGated(root, scriptPath("writer.ts"), [root, "0"]);
      expect(eventsOf(run.stdout)).toContain("writer:refused unsupported_dataset");
      // All 19 names are present here; only a field's physical type changed, so
      // a name-only gate would have opened a writable connection on it.
      expect(before).toContain("read_cursors");
      expect(await datasetState(root)).toBe(before);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an empty directory is refused before any table is created",
    async () => {
      const root = newDataset("gating-empty");
      const run = await runGated(root, scriptPath("writer.ts"), [root, "0"]);
      expect(eventsOf(run.stdout)).toContain("writer:refused unsupported_dataset");
      // The rejected open created no table and no dataset metadata: the lock
      // file the gate itself made is all that is there.
      expect(readdirSync(root).sort()).toEqual([LOCK_FILENAME]);
    },
    TEST_TIMEOUT_MS,
  );
});

// ── C. one owner per canonical dataset, inside one process ───────────────────

describe.skipIf(!FIXTURE_READY)(`single in-process owner [${PENDING_FIXTURE}]`, () => {
  test(
    "one owner per canonical dataset, alias spellings collide, and a gate is still required after close",
    async () => {
      const root = copyFixture("owners");
      const alias = join(scratch, "owners-alias");
      symlinkSync(root, alias);

      const run = await runGated(root, scriptPath("owners.ts"), [root, alias]);
      const events = eventsOf(run.stdout);

      expect(events).toContain("owner:first ready");
      // The registry is what catches these two. Both opens validate the same
      // inherited open file description, which is already held by this process,
      // so the descriptor check cannot tell them apart.
      expect(eventFor(events, "owner:second")).toBe("owner:second writer_unavailable");
      expect(eventFor(events, "owner:alias")).toBe("owner:alias writer_unavailable");
      // A live owner reads normally; an absent node is exactly null (§2).
      expect(eventFor(events, "owner:read")).toBe("owner:read null");
      // Closed is closed: the released adapter serves nothing further.
      expect(eventFor(events, "owner:readafterclose")).toBe("owner:readafterclose recovery_required");
      // Close released the descriptor, so the same process reopening without a
      // gate is refused. §3 asks for a held descriptor before EVERY open.
      expect(eventFor(events, "owner:reopen")).toBe("owner:reopen writer_unavailable");

      // Positive control, and the only thing it is claimed to show: the dataset
      // is still openable by a PROPERLY GATED owner, so the refusal above is
      // about the missing gate rather than a dataset left unusable. A fresh
      // process cannot show anything about the previous process's registry,
      // which lived and died with it.
      const regated = await runGated(root, scriptPath("writer.ts"), [root, "0"]);
      expect(eventsOf(regated.stdout)).toContain("writer:ready");
    },
    TEST_TIMEOUT_MS,
  );
});

// ── D. close waits for in-flight work, rejects queued work, releases the fd ──

describe.skipIf(!FIXTURE_READY)(`close lifetime [${PENDING_FIXTURE}]`, () => {
  test(
    "close waits for in-flight work, rejects what was queued, and frees the gate for another process",
    async () => {
      const root = copyFixture("close-lifetime");
      const seeded = JSON.stringify(fixture!.workspaces[FIXTURE_WORKSPACE]);
      const owner = spawnGatedChild(root, scriptPath("close.ts"), [
        root,
        seeded,
        FIXTURE_WORKSPACE,
        "20000",
      ]);
      const seen: string[] = [];

      try {
        // The §9 seam parks the first publish at a REAL sequence point, so the
        // second request is queued by construction rather than by timing luck.
        expect(await readUntil(owner, "boundary:before_append", seen)).toBe("boundary:before_append");
        expect(await readUntil(owner, "close:called", seen)).toBe("close:called");

        // §3: close waits for the request already in flight.
        expect(await readUntil(owner, "inflight", seen)).toBe("inflight resolved:accepted");
        // §3: and rejects the one that was still queued behind it.
        const queued = await readUntil(owner, "queued", seen);
        expect(queued.startsWith("queued rejected:")).toBe(true);
        expect(await readUntil(owner, "close", seen)).toBe("close resolved");

        // §3: close releases the fd. The owner process is deliberately still
        // alive here, so an acquiring contender proves the descriptor was
        // released by close rather than by process death.
        expect(await readUntil(owner, "owner:alive", seen)).toBe("owner:alive");
        const contender = await runChild([PYTHON, scriptPath("contend.py"), root]);
        expect(contender.events).toContain("gate:acquired");
      } finally {
        owner.kill();
        await owner.wait().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ── G. the reader is read-only and needs no gate ─────────────────────────────

describe.skipIf(!FIXTURE_READY)(`reader interface [${PENDING_FIXTURE}]`, () => {
  test(
    "a reader opens with no gate at all, even while a writer owns the dataset",
    async () => {
      const root = copyFixture("reader-no-gate");
      const holder = spawnChild([PYTHON, scriptPath("hold.py"), root, "20"]);
      await holder.waitForEvent("gate:acquired");

      // Unwrapped `bun run`: no launcher, no descriptor, no environment fields.
      const run = await runChild(["bun", "run", scriptPath("reader.ts"), root]);
      expect(run.events).toContain("reader:ready");
      expect(eventFor(run.events, "reader:read")).toBe("reader:read null");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the reader exposes exactly the three scoped read methods and no reachable handle",
    async () => {
      const root = copyFixture("reader-surface");
      const run = await runChild(["bun", "run", scriptPath("reader.ts"), root]);
      expect(eventFor(run.events, "reader:surface")).toBe(
        "reader:surface getAcceptedHead,listAcceptedHistory,listNodes",
      );
      // No publish, no close-the-writer, no adapter, and every value a function:
      // a raw table or connection would show up as an object here.
      expect(eventFor(run.events, "reader:valuetypes")).toBe("reader:valuetypes function");
      expect(eventFor(run.events, "reader:prototype")).toBe("reader:prototype true");
    },
    TEST_TIMEOUT_MS,
  );
});
