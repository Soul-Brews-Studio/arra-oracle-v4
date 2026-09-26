/**
 * #30 search-chunk recovery — lost ACK with deterministic no-duplicate
 * retry, the never-network-call guard, real SDK failure, corrupt retained
 * state, and the bounded/non-pageable reconcile sweep.
 *
 * Contract: `app/docs/contracts/search-chunk-v1.md`, §§1, 2, 4, 5, 6, 8.
 * Facade shape, queue/poison-both-directions and cross-factory exclusion
 * belong to `search-chunk-ownership.test.ts`; method semantics and grammar to
 * `search-chunk-service.test.ts`. None is duplicated here.
 *
 * Harness modelled directly on the accepted, hard-reviewed
 * `read-cursor-recovery.test.ts` and this lane's own `trace-recovery.test.ts`
 * sibling: a Python launcher (`exec_with_gate`) replaces itself in place with
 * a Bun child that holds the real writer gate, emits one JSON event per
 * line, and can be parked at a named boundary and SIGKILLed by the parent at
 * an exact pid. Unlike `createTrace`'s per-row triples, `indexRevisionChunks`
 * fires exactly ONE before_write/after_write/after_readback triple per call
 * regardless of chunk count — the whole target set lands in one
 * `writer.append`, so there is no per-chunk ambiguous-partial case in this
 * kernel; what replaces it is the deterministic-id guarantee proven below.
 *
 * What this file proves, per the shared brief:
 *
 * * A: a kill after the append lands but before the ACK — durable evidence
 *   read RAW (term_ids decoded from the Arrow list column, never assumed to
 *   already be a JS array), and a retry from a FRESH owner returns the SAME
 *   deterministic id and does NOT duplicate the row. `globalThis.fetch` is
 *   replaced with a fail-loud recorder for the ENTIRE run, including the
 *   retry: zero calls proves no model or network I/O anywhere on this path.
 * * B: `embedding_profile.dims !== 384` refuses at its field pointer, before
 *   any boundary fires, and the SAME owner still works immediately after.
 * * C: a REAL SDK failure (a permission-locked table directory) poisons with
 *   `recovery_required`; the table is repaired BETWEEN two requests on the
 *   SAME owner, observed as a handshake point, and the same owner is STILL
 *   refused; only a FRESH owner converges.
 * * D: a duplicate row planted at the SAME id before the readback is
 *   `integrity_failure` (the scoped `contextOne` "more than one" rule),
 *   poisoning the owner — one §5 class.
 * * E: a well-formed but UNEXPECTED stored `text` planted before the
 *   readback is `recovery_required`, poisoning the owner — the other §5
 *   class, kept distinct from D by an instrumented raw-storage interleave in
 *   the gated child itself (no second writer, no gate bypass).
 * * F: the reconcile sweep is bounded and explicitly NOT pageable — a second
 *   call with the same limit re-visits the SAME nodes rather than advancing,
 *   `exhausted` reports honestly, and a limit past the request grammar's own
 *   cap is refused before any query runs. Proven at small scale (2 nodes,
 *   `limit: 1`) rather than at the literal 1024-node contractual bound,
 *   which is prohibitively expensive to seed for a unit test — a disclosed,
 *   deliberate scope reduction of the MECHANISM, not of the grammar cap
 *   itself (which IS exercised at its real value, 1024).
 *
 * Bounded claims: process death and SDK-reported failure on local
 * Darwin/POSIX with pinned Python/Bun. Not power loss, not filesystem
 * hardware, not multiwriter. The gate stays a cooperative operator protocol.
 *
 * Ownership: this file and `test/fixtures/search-chunk-v1/recovery/**` only.
 */
import { afterAll, expect, test } from "bun:test";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@lancedb/lancedb";
import { PYTHON, createFixture, revisionEnvelope, runOwnedChild } from "./helpers/publication-fixture";
import { CHUNKER_VERSION, MAX_RECONCILE_REVISIONS, deriveChunkId, deriveContentHash } from "../src/publication/search-chunk";

// ── dependencies ────────────────────────────────────────────────────────────

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url)).replace(/\/test\/?$/, "");
const SERVICE_MODULE = join(SERVER_DIR, "src/publication/service.ts");
const RECOVERY_DIR = join(SERVER_DIR, "test/fixtures/search-chunk-v1/recovery");
const CHUNK_CHILD = join(RECOVERY_DIR, "search-chunk-child.ts");
const SILENT_CHILD = join(RECOVERY_DIR, "silent-child.ts");
const PY_SRC = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));

const MISSING: string[] = [
  [PYTHON, "python interpreter (set ARRA_CONTRACT_PYTHON)"],
  [SERVICE_MODULE, "src/publication/service.ts"],
  [CHUNK_CHILD, "fixtures/search-chunk-v1/recovery/search-chunk-child.ts"],
  [SILENT_CHILD, "fixtures/search-chunk-v1/recovery/silent-child.ts"],
]
  .filter(([path]) => !existsSync(path!))
  .map(([, label]) => label!);

if (existsSync(SERVICE_MODULE)) {
  const source = readFileSync(SERVICE_MODULE, "utf8");
  for (const symbol of ["indexRevisionChunks", "listSearchChunks", "reconcileSearchChunks"]) {
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

test("preflight: every search-chunk dependency this suite needs is present", () => {
  expect(MISSING).toEqual([]);
});

// ── creation records ────────────────────────────────────────────────────────

const createdRoots: { path: string; cleanup?: () => Promise<void> }[] = [];

async function scratchDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arra-chunk-recovery-${tag}-`));
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

const ALPHA = "alpha-workspace";
const CLOCK_MS = 1_790_400_000_000;
const PROFILE = { name: "recovery-profile", dims: 384 };
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

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
    clockMs: Array.from({ length: 8 }, (_, i) => CLOCK_MS + i * 1000),
    revisionIds: [],
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

async function launch(spec: Plan, tag: string, script = CHUNK_CHILD): Promise<Child> {
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

function stepResult(result: Run, step: number): { ok: boolean; value?: any; error?: any } {
  const event = result.events.find((e) => e.event === "step_result" && e.step === step);
  if (event === undefined) {
    throw new Error(`no step_result ${step}; events ${JSON.stringify(result.events)}\n${result.stderr}`);
  }
  return event.ok ? { ok: true, value: event.value } : { ok: false, error: event.error };
}

function okValue(result: Run, step: number): any {
  const outcome = stepResult(result, step);
  if (!outcome.ok) throw new Error(`step ${step} failed: ${JSON.stringify(outcome.error)}`);
  return outcome.value;
}

function errorOf(result: Run, step: number): Record<string, unknown> {
  const outcome = stepResult(result, step);
  if (outcome.ok) throw new Error(`step ${step} unexpectedly succeeded: ${JSON.stringify(outcome.value)}`);
  return outcome.error;
}

function fetchCallsOf(result: Run): number {
  const event = result.events.find((e) => e.event === "fetch_calls");
  return event === undefined ? -1 : event.count;
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

/**
 * `term_ids` is decoded EXPLICITLY as an Arrow list column: the measured
 * shape (per `search-chunk-v1.md` §2 and `gated-search.ts`'s own empirical
 * harness) is a raw apache-arrow `Vector` exposing `.toArray()`, not a plain
 * JS array — a generic `String(value)` fallback would silently produce
 * `"[object Object]"` here instead of the real element list.
 */
async function chunkRows(datasetRoot: string, predicate?: string): Promise<Record<string, unknown>[]> {
  const db = await connect(datasetRoot, { readConsistencyInterval: 0 });
  const handle = await db.openTable("search_chunks_v1");
  await handle.checkoutLatest();
  const query = predicate === undefined ? handle.query() : handle.query().where(predicate);
  const arrow = await query.toArrow();
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < arrow.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const field of arrow.schema.fields) {
      const column = arrow.getChild(field.name)!;
      if (field.name === "term_ids") {
        if (!column.isValid(i)) {
          row[field.name] = null;
          continue;
        }
        const value = column.get(i) as { toArray?: () => unknown[] } | unknown[];
        row[field.name] = Array.isArray(value)
          ? value.map((item) => (item === null ? null : String(item)))
          : (value as { toArray(): unknown[] }).toArray().map((item) => (item === null ? null : String(item)));
        continue;
      }
      row[field.name] = rawCell(column, i);
    }
    rows.push(row);
  }
  return rows;
}

/** The authored expectation for one fresh, single-chunk index row — the seed
 *  content ("a title\n\na body") is well under the 1000-char chunk size, so
 *  this is always exactly one chunk at index 0. Never echoed back from the
 *  write under test. */
function expectedChunkRow(revisionId: string, nodeId: string, seeded: { term_ids: { type: { note: { id: string } } }; session_name: string }) {
  const text = "a title\n\na body";
  return {
    id: deriveChunkId(revisionId, CHUNKER_VERSION, PROFILE.name, 0n),
    workspace_name: ALPHA,
    node_id: nodeId,
    revision_id: revisionId,
    chunk_index: 0n,
    text,
    content_hash: deriveContentHash(text),
    chunker_version: CHUNKER_VERSION,
    embedding_profile: PROFILE.name,
    embedding: null,
    type_term_id: seeded.term_ids.type.note.id,
    term_ids: [seeded.term_ids.type.note.id],
    observer_peer_name: null,
    subject_peer_name: null,
    session_name: seeded.session_name,
    status: "pending",
    attempts: 0n,
    last_attempt_at: null,
    embedded_at: null,
    error_code: null,
  };
}

// ── gated writes for states the service never creates ───────────────────────

const GATED_WRITE_SOURCE = `
import json, sys

import lancedb
import pyarrow as pa
from arra_migrate.writer_gate import writer_gate

root = sys.argv[1]
with open(sys.argv[2], encoding="utf-8") as handle:
    plan = json.load(handle)

with writer_gate(root):
    db = lancedb.connect(root)
    for item in plan:
        table = db.open_table(item["table"])
        schema = table.schema
        rows = []
        for row in item["rows"]:
            built = {}
            for field in schema:
                value = row.get(field.name)
                if value is None:
                    built[field.name] = None
                elif pa.types.is_integer(field.type):
                    built[field.name] = int(value)
                else:
                    built[field.name] = value
            rows.append(built)
        table.add(pa.Table.from_pylist(rows, schema=schema))
print(json.dumps({"ok": True}))
`;

async function gatedWrite(datasetRoot: string, table: string, rows: Record<string, unknown>[]): Promise<void> {
  const dir = await scratchDir("plant");
  const planPath = join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify([{ table, rows }]), "utf8");
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

// ── a fixture with one real accepted revision already published ────────────

type Fixture = { root: string; seeded: { term_ids: { type: { note: { id: string } } }; session_name: string }; node: string; revision: string };

async function fixtureWithRevision(tag: string): Promise<Fixture> {
  const created = await createFixture([ALPHA]);
  createdRoots.push({ path: created.datasetRoot, cleanup: created.cleanup });
  const seeded = created.workspaces[ALPHA]!;
  const node = pad(`${tag}-node`);
  const revision = pad(`${tag}-rev`);
  const published = await run(
    plan(
      created.datasetRoot,
      [
        {
          facade: "publication",
          method: "publishRevision",
          request: { operation_id: `${tag}-op`, content: revisionEnvelope(ALPHA, seeded, node) },
        },
      ],
      { revisionIds: [revision] },
    ),
    `${tag}-publish`,
  );
  expect(okValue(published, 0).outcome).toBe("accepted");
  return { root: created.datasetRoot, seeded, node, revision };
}

const indexStep = (node: string, revision: string, overrides: Record<string, unknown> = {}): Step => ({
  facade: "context",
  method: "indexRevisionChunks",
  request: {
    workspace_name: ALPHA,
    node_id: node,
    revision_id: revision,
    chunker_version: CHUNKER_VERSION,
    embedding_profile: PROFILE,
    ...overrides,
  },
});

// ── A. lost ACK, deterministic no-duplicate retry, and the network guard ───

recoveryTest(
  "A1 a kill after the append lands but before the ACK is durable with the term_ids Vector decoded, fetch untouched, and the retry converges on the SAME id without duplicating",
  async () => {
    const fixture = await fixtureWithRevision("a1");
    const step = indexStep(fixture.node, fixture.revision);

    const killed = await runAndKillAtPark(plan(fixture.root, [step], { parkAt: { name: "after_write", n: 1 } }), "a1-crash");
    expect(killed.events.at(-1)?.event).toBe("parked");
    expect(killed.events.some((e) => e.event === "step_result")).toBe(false);

    const durable = await chunkRows(fixture.root);
    expect(durable).toEqual([expectedChunkRow(fixture.revision, fixture.node, fixture.seeded)]);

    // The SAME deterministic id on retry, from a FRESH owner: already_satisfied,
    // not a second row.
    const replay = await run(plan(fixture.root, [step]), "a1-replay");
    const result = okValue(replay, 0);
    expect(result.outcome).toBe("already_satisfied");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(deriveChunkId(fixture.revision, CHUNKER_VERSION, PROFILE.name, 0n));
    expect(await chunkRows(fixture.root)).toHaveLength(1);

    // Network guard: zero fetch calls across BOTH the crashed attempt and the
    // recovery retry — no model or network call anywhere on this path.
    expect(fetchCallsOf(replay)).toBe(0);
  },
);

// ── B. a frozen-dimension refusal writes nothing and does not poison ───────

recoveryTest(
  "B1 embedding_profile.dims !== 384 refuses at its field pointer before any boundary, and the owner still works",
  async () => {
    const fixture = await fixtureWithRevision("b1");
    const bad = indexStep(fixture.node, fixture.revision, { embedding_profile: { name: PROFILE.name, dims: 768 } });
    const good = indexStep(fixture.node, fixture.revision);
    const result = await run(plan(fixture.root, [bad, good]), "b1");

    const rejected = errorOf(result, 0);
    expect({ name: rejected.name, version: rejected.version, code: rejected.code, path: rejected.path }).toEqual({
      name: "ContractError",
      version: "arra-error/v1",
      code: "invalid_value",
      path: "/embedding_profile/dims",
    });
    // No boundary at all fired for the rejected call: a pure parse-time
    // refusal, entirely before mutate() and the write queue.
    expect(result.events.filter((e) => e.event === "boundary" && e.step === 0)).toEqual([]);

    expect(okValue(result, 1).outcome).toBe("indexed");
    expect(await chunkRows(fixture.root)).toHaveLength(1);
  },
);

// ── C. a real SDK failure, repaired BEFORE the second same-owner request ───

recoveryTest("C1 a real SDK failure poisons, and a REPAIRED table does not un-poison the SAME owner", async () => {
  const fixture = await fixtureWithRevision("c1");
  const table = join(fixture.root, "search_chunks_v1.lance");
  const request = indexStep(fixture.node, fixture.revision);

  const child = await launch(
    plan(fixture.root, [request, request], {
      parkAt: { name: "before_write", n: 1 },
      emitPark: "after_response_emission",
      resumeOnStdin: true,
    }),
    "c1",
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
  // A "fetch_calls" summary is emitted once, right before "done".
  expect(observed).toEqual([
    "ready",
    "parked",
    "step_result",
    "post_emit",
    "repaired",
    "step_result",
    "fetch_calls",
    "done",
  ]);

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

  // Pinned to "indexed", not a disjunction with "already_satisfied":
  // `lockTree` chmods BEFORE `child.resume()`, so `writer.append` itself
  // fails on BOTH poisoned attempts (permission denied on the real SDK
  // call) -- `toWrite` was never durably appended by either one. A fresh
  // owner is therefore doing a genuinely first write.
  const fresh = await run(plan(fixture.root, [request]), "c1-fresh");
  expect(okValue(fresh, 0).outcome).toBe("indexed");
});

// ── D/E. post-readback corrupt state, by instrumented in-process interleave ─

recoveryTest("D1 a duplicate row planted before the readback is integrity_failure and poisons the owner", async () => {
  const fixture = await fixtureWithRevision("d1");
  const expectedRow = expectedChunkRow(fixture.revision, fixture.node, fixture.seeded);
  const request = indexStep(fixture.node, fixture.revision);

  const result = await run(
    plan(fixture.root, [request, request], {
      injectAt: { name: "after_write", n: 1 },
      injection: {
        kind: "duplicate_chunk",
        row: {
          id: expectedRow.id,
          workspace_name: ALPHA,
          node_id: fixture.node,
          revision_id: fixture.revision,
          chunk_index: 0,
          text: expectedRow.text,
          content_hash: expectedRow.content_hash,
          chunker_version: CHUNKER_VERSION,
          embedding_profile: PROFILE.name,
          embedding: null,
          type_term_id: expectedRow.type_term_id,
          term_ids: expectedRow.term_ids,
          observer_peer_name: null,
          subject_peer_name: null,
          session_name: fixture.seeded.session_name,
          status: "pending",
          attempts: 0,
          last_attempt_at: null,
          embedded_at: null,
          error_code: null,
        },
      },
    }),
    "d1",
  );

  const injected = result.events.find((e) => e.event === "injected");
  expect(injected).toEqual({ event: "injected", name: "after_write", n: 1, step: 0 });
  expect(result.events.some((e) => e.event === "boundary" && e.name === "after_readback")).toBe(false);

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
  // No rollback and no repair: exactly two rows at the one id remain.
  const remaining = await chunkRows(fixture.root, `id = '${expectedRow.id}'`);
  expect(remaining).toHaveLength(2);
});

recoveryTest("E1 a well-formed UNEXPECTED stored text before the readback is recovery_required and poisons", async () => {
  const fixture = await fixtureWithRevision("e1");
  const expectedRow = expectedChunkRow(fixture.revision, fixture.node, fixture.seeded);
  const request = indexStep(fixture.node, fixture.revision);

  const result = await run(
    plan(fixture.root, [request, request], {
      injectAt: { name: "after_write", n: 1 },
      injection: {
        kind: "unexpected_text",
        text: "not the text this call wrote",
        where: `id = '${expectedRow.id}'`,
      },
    }),
    "e1",
  );

  expect(result.events.find((e) => e.event === "injected")).toEqual({ event: "injected", name: "after_write", n: 1, step: 0 });
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
  // The planted text stands: no rollback, no repair.
  const remaining = await chunkRows(fixture.root, `id = '${expectedRow.id}'`);
  expect(remaining).toHaveLength(1);
  expect(remaining[0]!.text).toBe("not the text this call wrote");
});

// ── F. the reconcile sweep is bounded and NOT pageable ──────────────────────

recoveryTest(
  "F1 a limit past the request grammar's own cap is refused before any query runs",
  async () => {
    const fixture = await fixtureWithRevision("f1-cap");
    const result = await run(
      plan(fixture.root, [
        { facade: "context", method: "reconcileSearchChunks", request: { workspace_name: ALPHA, limit: MAX_RECONCILE_REVISIONS + 1 } },
      ]),
      "f1-cap",
    );
    const rejected = errorOf(result, 0);
    expect({ name: rejected.name, version: rejected.version, code: rejected.code, path: rejected.path }).toEqual({
      name: "ContractError",
      version: "arra-error/v1",
      code: "invalid_value",
      path: "/limit",
    });
  },
);

recoveryTest(
  "F2 at small scale: a second call with the SAME limit re-visits the SAME node rather than advancing, and exhausted reports honestly",
  async () => {
    // Two accepted nodes, one indexed and one not, with a limit of 1: proves
    // "not pageable" and "exhausted reports honestly" at a scale a unit test
    // can actually seed — the literal 1024-node bound is exercised for its
    // GRAMMAR cap only, in F1 above, not reseeded here.
    //
    // ORDERING, stated precisely and BITE-TESTED, not assumed: `service.ts`'s
    // `reconcileSearchChunks` does NOT call a bare `query()` (which carries no
    // order in this codebase) -- it calls `writer.orderedProjection("nodes",
    // ..., { column: "id", ascending: true }, ...)`, and `orderedProjection`
    // (service.ts's DatasetAdapter, ~line 263) issues a REAL `.orderBy([{
    // columnName: "id", ascending: true }])` against the query before
    // `.toArrow()`. The visit order is therefore a genuine, explicit contract
    // -- ascending by node `id` -- not an accident of storage layout.
    //
    // To prove this is really what's exercised here (not merely a
    // coincidence of creation order, which happens to equal id order unless
    // deliberately decoupled): `nodeFirst` is PUBLISHED first but has the
    // LEXICALLY LARGER id; `nodeSecond` is published second but has the
    // LEXICALLY SMALLER id, and is the one that gets indexed. If the real
    // order were creation-order (or unordered), a limit-1 sweep would visit
    // `nodeFirst` (unindexed) and report `missing: 1`. Because the real order
    // is ascending id, it visits `nodeSecond` (indexed) and reports
    // `missing: 0` -- so this test WOULD fail loudly if that ordering
    // guarantee ever regressed to creation-order or to no order at all.
    const created = await createFixture([ALPHA]);
    createdRoots.push({ path: created.datasetRoot, cleanup: created.cleanup });
    const seeded = created.workspaces[ALPHA]!;
    const nodeFirst = pad("f2-nodeZZZ"); // published 1st, lexically LARGER id
    const nodeSecond = pad("f2-nodeAAA"); // published 2nd, lexically SMALLER id
    expect(nodeSecond < nodeFirst).toBe(true); // the premise this test relies on
    const revFirst = pad("f2-revFirst");
    const revSecond = pad("f2-revSecond");

    const published = await run(
      plan(
        created.datasetRoot,
        [
          { facade: "publication", method: "publishRevision", request: { operation_id: "f2-op-first", content: revisionEnvelope(ALPHA, seeded, nodeFirst) } },
          { facade: "publication", method: "publishRevision", request: { operation_id: "f2-op-second", content: revisionEnvelope(ALPHA, seeded, nodeSecond) } },
          // Only the lexically SMALLER (second-published) node is indexed.
          indexStep(nodeSecond, revSecond),
        ],
        { revisionIds: [revFirst, revSecond] },
      ),
      "f2-setup",
    );
    expect(okValue(published, 0).outcome).toBe("accepted");
    expect(okValue(published, 1).outcome).toBe("accepted");
    expect(okValue(published, 2).outcome).toBe("indexed");

    const reconcileStep = (): Step => ({
      facade: "context",
      method: "reconcileSearchChunks",
      request: { workspace_name: ALPHA, limit: 1 },
    });

    const first = await run(plan(created.datasetRoot, [reconcileStep()]), "f2-first");
    const firstValue = okValue(first, 0);
    expect(firstValue).toEqual({
      visited: 1,
      // The visited node is the ASCENDING-ID-FIRST one (`nodeSecond`), which
      // WAS indexed -- not `nodeFirst`, which was published first but sorts
      // after it and was never visited by this limit-1 call.
      missing: 0,
      missing_revisions: [],
      stale: 0,
      exhausted: false,
      ineligible: 0,
    });

    // A second call, SAME limit: the SAME node (still `nodeSecond`), not the
    // next one (`nodeFirst`) -- proving the sweep does not advance.
    const second = await run(plan(created.datasetRoot, [reconcileStep()]), "f2-second");
    expect(okValue(second, 0)).toEqual(firstValue);
  },
);

// ── G. the parent's own bounds are refutable ────────────────────────────────

recoveryTest("G1 the parent deadline fires: a silent child is killed and reaped", async () => {
  const fixture = await fixtureWithRevision("g1");
  const child = await launch(plan(fixture.root, []), "g1", SILENT_CHILD);
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
});
