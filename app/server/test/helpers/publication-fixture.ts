/**
 * Shared harness for the #26 publication tests.
 *
 * Creates a real target19 dataset in a scratch directory via the Python
 * exporter, and runs publication work inside a process that genuinely holds
 * the writer gate.
 *
 * Everything here is ephemeral and owned by the test that asked for it: no
 * live dataset, no R2, no model call, no network. Children get a
 * parent-enforced deadline and are killed by exact PID and reaped.
 *
 * Bounded-claim reminder for anything built on this: the lock is a
 * cooperative operator protocol, SDK readback is not power-loss proof, and
 * these helpers do not defend against same-UID code that imports the SDK
 * directly and declines to take the gate.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertExecLimits } from "./argv.assertExecLimits";
import { spillOversizedArgs } from "./argv.spillOversizedArgs";

/** Deadline every owned child is held to, in milliseconds. */
export const CHILD_DEADLINE_MS = 60_000;

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const MIGRATE_DIR = join(REPO_ROOT, "app", "migrate-py");

/**
 * The interpreter to run Python helpers with.
 *
 * A helper worktree has no `.venv` of its own, so `ARRA_CONTRACT_PYTHON`
 * points at one that exists. Same precedent as the cross-language tests.
 */
export const PYTHON = process.env.ARRA_CONTRACT_PYTHON ?? join(MIGRATE_DIR, ".venv", "bin", "python");

/** `arra_migrate` must be importable even when running from another worktree. */
function pythonEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const ownSrc = join(MIGRATE_DIR, "src");
  const inherited = process.env.PYTHONPATH;
  return {
    ...process.env,
    PYTHONPATH: inherited ? `${ownSrc}:${inherited}` : ownSrc,
    ...extra,
  };
}

/** Bounded stderr capture: a runaway child must not buffer without limit. */
const MAX_CAPTURED_STDERR = 64 * 1024;

export type SeededTerm = {
  id: string;
  name: string;
  vocabulary_id: string;
  vocabulary_name: string;
  is_active: boolean;
};

export type SeededWorkspace = {
  workspace_id: string;
  peer_names: string[];
  session_name: string;
  vocabulary_ids: { type: string; memory_horizon: string; topic: string };
  term_ids: {
    type: { note: SeededTerm; decision: SeededTerm };
    memory_horizon: { short_term: SeededTerm };
    topic: { storage: SeededTerm; retired_topic: SeededTerm };
  };
  message_public_id: string;
  trace_id: string;
};

export type Fixture = {
  /** The dataset directory the exporter created. */
  datasetRoot: string;
  workspaces: Record<string, SeededWorkspace>;
  cleanup: () => Promise<void>;
};

export type RunResult = { code: number; stdout: string; stderr: string };

/**
 * Run an owned child with a parent-enforced deadline.
 *
 * On timeout the child is SIGKILLed by its exact PID and reaped; nothing here
 * matches on a process name or pattern. An argv or env string Linux would
 * refuse with E2BIG is refused here on every platform, before any spawn.
 */
export function runOwnedChild(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; deadlineMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const env = pythonEnv(options.env);
    assertExecLimits(command, args, env);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, options.deadlineMs ?? CHILD_DEADLINE_MS);

    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    // stderr is DRAINED, not merely ignored: an undrained pipe can fill and
    // block the child, which would look like a hang rather than an error.
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_CAPTURED_STDERR) stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Create a fresh seeded target19 dataset.
 *
 * Two workspaces by default: the cross-workspace rejection cases need
 * genuinely separate seeded data, not a lookup that always says yes.
 */
export async function createFixture(
  workspaceNames: string[] = ["alpha-workspace", "beta-workspace"],
): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "arra-pub26-"));
  const result = await runOwnedChild(
    PYTHON,
    [join("tests", "export_publication_fixture.py"), parent, ...workspaceNames],
    { cwd: MIGRATE_DIR },
  );
  if (result.code !== 0) {
    await rm(parent, { recursive: true, force: true });
    throw new Error(`fixture exporter failed (${result.code}): ${result.stderr.slice(0, 400)}`);
  }

  let payload: { dataset_root: string; workspaces: Record<string, SeededWorkspace> };
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    await rm(parent, { recursive: true, force: true });
    throw new Error(`fixture exporter did not print JSON: ${result.stdout.slice(0, 400)}`);
  }

  return {
    datasetRoot: payload.dataset_root,
    workspaces: payload.workspaces,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

/**
 * Run a Bun script INSIDE the writer gate.
 *
 * `exec_with_gate` replaces the Python process in place, so the returned PID
 * is the Bun program itself and there is no second lock holder. A caller that
 * wants to kill mid-run should use `spawnGatedChild` instead.
 *
 * An argument over the inline limit reaches the child as a file reference
 * (`argv.spillOversizedArgs.ts`); the child decodes it with `readArgPayload`.
 */
export async function runGated(
  datasetRoot: string,
  scriptPath: string,
  args: string[] = [],
  options: { deadlineMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const spill = spillOversizedArgs(args);
  const launcher = [
    "-c",
    [
      "import sys",
      "from arra_migrate.writer_gate import exec_with_gate",
      "exec_with_gate(sys.argv[1], sys.argv[2:])",
    ].join("\n"),
    datasetRoot,
    process.execPath,
    scriptPath,
    ...spill.args,
  ];
  try {
    return await runOwnedChild(PYTHON, launcher, { cwd: MIGRATE_DIR, ...options });
  } finally {
    spill.cleanup();
  }
}

/** A gated child kept alive so the parent can kill it at a chosen moment. */
export type GatedChild = {
  readonly pid: number | undefined;
  /** Whatever the child has written to stderr so far, bounded. */
  readonly stderr: string;
  /** The next line the child prints, bounded by a parent deadline. */
  nextLine(deadlineMs?: number): Promise<string>;
  kill(): void;
  /** Bounded wait for exit. Safe to call after the child already closed. */
  wait(deadlineMs?: number): Promise<number>;
};

export function spawnGatedChild(
  datasetRoot: string,
  scriptPath: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): GatedChild {
  // Same spill and E2BIG guard as `runGated`; the spill is removed on close.
  const spill = spillOversizedArgs(args);
  const launcher = [
    "-c",
    [
      "import sys",
      "from arra_migrate.writer_gate import exec_with_gate",
      "exec_with_gate(sys.argv[1], sys.argv[2:])",
    ].join("\n"),
    datasetRoot,
    process.execPath,
    scriptPath,
    ...spill.args,
  ];
  const childEnv = pythonEnv(env);
  try {
    assertExecLimits(PYTHON, launcher, childEnv);
  } catch (error) {
    spill.cleanup();
    throw error;
  }
  const child = spawn(PYTHON, launcher, { cwd: MIGRATE_DIR, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  // Registered FIRST, so the spill is gone before any exit waiter resumes.
  child.on("close", () => spill.cleanup());
  child.on("error", () => spill.cleanup());

  // The exit promise is created AT SPAWN, not when wait() is first called.
  // Registering the listener lazily meant calling wait() after the child had
  // already closed waited forever for an event that had come and gone.
  let exitCode: number | null = null;
  let spawnError: Error | null = null;
  const exited = new Promise<number>((resolveExit, rejectExit) => {
    child.on("close", (code) => {
      exitCode = code ?? -1;
      resolveExit(exitCode);
    });
    child.on("error", (error) => {
      spawnError = error as Error;
      rejectExit(error);
    });
  });
  // Nothing may reject unhandled if the caller never awaits.
  exited.catch(() => undefined);

  let buffer = "";
  let stderr = "";
  const pending: { deliver: (line: string) => void; fail: (error: Error) => void }[] = [];

  const flush = () => {
    let index = buffer.indexOf("\n");
    while (index !== -1 && pending.length > 0) {
      const waiter = pending.shift()!;
      waiter.deliver(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  };

  child.stdout?.on("data", (chunk) => {
    buffer += String(chunk);
    flush();
  });
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < MAX_CAPTURED_STDERR) stderr += String(chunk);
  });
  // A child that dies before speaking must fail every waiter, not hang them.
  child.on("close", () => {
    while (pending.length > 0) {
      pending.shift()!.fail(new Error(`child exited (${exitCode}) before producing a line: ${stderr.slice(0, 400)}`));
    }
  });

  return {
    get pid() {
      return child.pid;
    },
    get stderr() {
      return stderr;
    },
    nextLine(deadlineMs = CHILD_DEADLINE_MS) {
      return new Promise<string>((resolveLine, reject) => {
        if (spawnError !== null) {
          reject(spawnError);
          return;
        }
        const existing = buffer.indexOf("\n");
        if (existing !== -1) {
          const line = buffer.slice(0, existing);
          buffer = buffer.slice(existing + 1);
          resolveLine(line);
          return;
        }
        if (exitCode !== null) {
          reject(new Error(`child already exited (${exitCode}): ${stderr.slice(0, 400)}`));
          return;
        }
        const waiter = {
          deliver: (line: string) => {
            clearTimeout(timer);
            resolveLine(line);
          },
          fail: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          // REMOVE the waiter: leaving it queued would hand a later line to a
          // promise nobody is listening to, desynchronising every read after.
          const index = pending.indexOf(waiter);
          if (index !== -1) pending.splice(index, 1);
          reject(new Error("child produced no line before its deadline"));
        }, deadlineMs);
        pending.push(waiter);
      });
    },
    kill() {
      child.kill("SIGKILL");
    },
    /**
     * Await exit, bounded by the parent.
     *
     * Always safe to call, including after the child has already closed. The
     * caller is still expected to `kill()` then `await wait()` in a `finally`
     * so no owner is left holding the gate.
     */
    async wait(deadlineMs = CHILD_DEADLINE_MS) {
      if (exitCode !== null) return exitCode;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<number>((_, reject) => {
        timer = setTimeout(() => reject(new Error("child did not exit before its deadline")), deadlineMs);
      });
      try {
        return await Promise.race([exited, bounded]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

/** Encode a request body the way every publication method expects it. */
export const encodeRequest = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

/**
 * A complete, valid 21-key revision envelope for a seeded workspace.
 *
 * `label_snapshot` is null by contract for new content, and the type term is
 * always assigned because exactly one reserved type assignment is required.
 */
export function revisionEnvelope(
  workspace: string,
  seeded: SeededWorkspace,
  nodeId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const typeTerm = seeded.term_ids.type.note;
  return {
    workspace_name: workspace,
    node_id: nodeId,
    base_revision_id: null,
    title: "a title",
    body: "a body",
    body_format: "markdown",
    fields: "{}",
    author_peer_name: seeded.peer_names[0] ?? null,
    observer_peer_name: null,
    subject_peer_name: null,
    session_name: seeded.session_name,
    is_active: true,
    valid_from: null,
    valid_to: null,
    change_reason: null,
    schema_version: "1",
    canonical_version: "arra-revision/v1",
    term_snapshot_json: JSON.stringify([
      {
        term_id: typeTerm.id,
        vocabulary_id: typeTerm.vocabulary_id,
        vocabulary_name_snapshot: typeTerm.vocabulary_name,
        term_name_snapshot: typeTerm.name,
        label_snapshot: null,
        position: "0",
      },
    ]),
    link_snapshot_json: "[]",
    h_metadata: null,
    internal_metadata: null,
    ...overrides,
  };
}

/** A deterministic nanoid21 generator for tests. */
export function idSource(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const suffix = String(counter).padStart(4, "0");
    return `${prefix}${"_".repeat(Math.max(0, 21 - prefix.length - suffix.length))}${suffix}`.slice(0, 21);
  };
}
