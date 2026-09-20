/**
 * #28 association materialization recovery — traces, rebuild faults, fail-stop (#67).
 *
 * Contract: `app/docs/contracts/association-evidence-v1.md`
 * SHA256 b4a9660de8e1d669396769f12973284973661fced86214e5f7b447b785e83f1e
 * Base: f9e5abe8ab80514198beac554dd10ef610c0f264
 *
 * What this file is responsible for, per §8 Recovery:
 *
 * * The four reconciliation shapes — unchanged, filled, rebuilt and mixed —
 *   proved by the LITERAL frozen trace (§5: one delete triple per replaced
 *   table, one triple per appended row, all term boundaries before any link
 *   boundary, silence for skipped rows) AND by the persisted identity sets AND
 *   by the response `action` fields. Any one of the three alone is weaker than
 *   the contract asks for.
 * * Crash at the delete, between appends, at a readback and after the ACK is
 *   lost; a fresh owner re-derives and converges without duplicates.
 * * While the materializer is PARKED mid-rebuild, a separate gateless reader
 *   returns byte-identical association content, and the authoritative snapshot
 *   rows are unchanged — because reads derive from snapshots, never from the
 *   derived tables being rebuilt.
 * * Full distractor preservation: rows of another revision and another
 *   workspace survive a rebuild byte-for-byte, compared on every column. Two
 *   sampled rows would not prove this, which is why the fixtures carry a
 *   complete set.
 * * A real SDK failure, with the parent's repair asserted as an observed
 *   handshake point BEFORE the same-owner refusal. Never a repair in `finally`.
 * * Safe pre-write refusal leaves the owner usable; a failure after an
 *   attempted write poisons it. The result shape does not distinguish these —
 *   only the owner's state afterwards does.
 *
 * Bounded claims: process death and SDK-reported failure on local Darwin/POSIX
 * with pinned Python/Bun. Not power loss, not filesystem hardware, not
 * multiwriter. The gate stays a cooperative operator protocol.
 *
 * Cleanup is by CREATION RECORD: every dataset and scratch root is registered
 * the moment it is made, and teardown removes exactly those. An earlier lane
 * cleaned by shared prefix and mtime window, which would have deleted a
 * concurrent lane's live fixture had the timing lined up.
 *
 * Ownership: this file and `test/fixtures/association-v1/recovery/**` only.
 */
import { afterAll, expect, test } from "bun:test";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@lancedb/lancedb";
import { obj } from "../src/contracts/jcs";
import { targetOp } from "../src/contracts/evidence-v1";
import { PYTHON, runOwnedChild } from "./helpers/publication-fixture";
import { createTaxonomyFixture } from "./helpers/taxonomy-fixture";

// ── dependencies ────────────────────────────────────────────────────────────

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url)).replace(/\/test\/?$/, "");
const SERVICE_MODULE = join(SERVER_DIR, "src/publication/service.ts");
const RECOVERY_DIR = join(SERVER_DIR, "test/fixtures/association-v1/recovery");
const EVIDENCE_CHILD = join(RECOVERY_DIR, "evidence-child.ts");
const READER_CHILD = join(RECOVERY_DIR, "reader-child.ts");
const SILENT_CHILD = join(RECOVERY_DIR, "silent-child.ts");
const PY_SRC = fileURLToPath(new URL("../../migrate-py/src", import.meta.url));
const EXPORTER = fileURLToPath(new URL("../../migrate-py/tests/export_taxonomy_fixture.py", import.meta.url));

const MISSING: string[] = [
  [PYTHON, "python interpreter (set ARRA_CONTRACT_PYTHON)"],
  [EXPORTER, "export_taxonomy_fixture.py (accepted bare fixture creator)"],
  [SERVICE_MODULE, "src/publication/service.ts"],
  [EVIDENCE_CHILD, "fixtures/association-v1/recovery/evidence-child.ts"],
  [READER_CHILD, "fixtures/association-v1/recovery/reader-child.ts"],
  [SILENT_CHILD, "fixtures/association-v1/recovery/silent-child.ts"],
]
  .filter(([path]) => !existsSync(path!))
  .map(([, label]) => label!);

// A present service.ts is not yet an evidence-capable one. Bounded SOURCE-TEXT
// check, labelled as such: it separates "core has not landed" from "core is
// broken", and it is not module resolution.
if (existsSync(SERVICE_MODULE)) {
  const source = readFileSync(SERVICE_MODULE, "utf8");
  for (const symbol of ["openEvidenceWriter", "openEvidenceReader"]) {
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

test("preflight: every association dependency this suite needs is present", () => {
  // Red while pending. A skipped case is never acceptance.
  expect(MISSING).toEqual([]);
});

// ── creation records ────────────────────────────────────────────────────────

/**
 * Every root this run creates, recorded AT CREATION.
 *
 * Not a prefix scan and not an mtime window: those identify roots that look
 * like mine, which is a different claim from roots that are mine. A shared
 * helper prefix plus a coincident timestamp is exactly how a concurrent lane's
 * live fixture gets deleted.
 */
const createdRoots: { path: string; kind: "dataset" | "scratch"; cleanup?: () => Promise<void> }[] = [];

async function scratchDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arra-assoc-recovery-${tag}-`));
  createdRoots.push({ path: dir, kind: "scratch" });
  return dir;
}

afterAll(async () => {
  // Each teardown isolated: one failure must not strand the rest, and what it
  // could not remove is named by path rather than counted.
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
const OTHER_WORKSPACE = "beta-workspace";

let idCounter = 0;
function id21(label: string): string {
  idCounter += 1;
  const body = `Asc${label}${idCounter}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return (body + "_".repeat(21)).slice(0, 21);
}

/** Two external-locator links: passive by contract, so no session or trace is needed. */
function linkSnapshot(urls: string[]): string {
  return JSON.stringify(
    urls.map((url, index) => ({
      position: String(index),
      relation: "supports",
      target_kind: "url",
      target: { url },
      excerpt: null,
      content_hash: null,
      captured_at: null,
      capture_status: "locator_only",
      note: null,
    })),
  );
}

type Seeded = { typeVocabulary: string; noteTerm: string };

/** The reserved seed manifest, authored here rather than taken from a builder. */
function seedRequest(workspace: string, seeded: Seeded, extra: Record<string, string>) {
  return {
    workspace_name: workspace,
    type: {
      vocabulary_id: seeded.typeVocabulary,
      terms: {
        note: seeded.noteTerm,
        conclusion: extra.conclusion!,
        learning: extra.learning!,
        discussion: extra.discussion!,
        correction: extra.correction!,
      },
    },
    memory_horizon: {
      vocabulary_id: extra.horizonVocabulary!,
      terms: { short_term: extra.short_term!, long_term: extra.long_term! },
    },
  };
}

function revisionContent(
  workspace: string,
  nodeId: string,
  seeded: Seeded,
  options: { base?: string | null; title?: string; urls?: string[] } = {},
) {
  return {
    workspace_name: workspace,
    node_id: nodeId,
    base_revision_id: options.base ?? null,
    title: options.title ?? "association subject",
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
    term_snapshot_json: JSON.stringify([
      {
        label_snapshot: null,
        position: "0",
        term_id: seeded.noteTerm,
        term_name_snapshot: "note",
        vocabulary_id: seeded.typeVocabulary,
        vocabulary_name_snapshot: "type",
      },
    ]),
    link_snapshot_json: linkSnapshot(options.urls ?? ["https://example.invalid/a", "https://example.invalid/b"]),
    h_metadata: null,
    internal_metadata: null,
  };
}

/**
 * The complete expected derived rows, AUTHORED here.
 *
 * Deliberately not read back from a previous materialization. Comparing a
 * retry against whatever the first run produced makes the materializer its own
 * oracle: a consistently wrong first pass would be reproduced exactly and the
 * test would agree with it. Only `target`/`target_key` come from the governed
 * codec — the contract requires both to come from the SAME `targetOp` result,
 * and that codec is a byte contract rather than a source of truth about which
 * rows should exist.
 *
 * Field order and physical types follow §3: positions are Int64, so they are
 * BigInt here and travel through the same serializer as the stored rows.
 */
function expectedTermRows(workspace: string, revisionId: string, seeded: Seeded): string[] {
  return stable([
    {
      workspace_name: workspace,
      revision_id: revisionId,
      term_id: seeded.noteTerm,
      vocabulary_id: seeded.typeVocabulary,
      vocabulary_name_snapshot: "type",
      term_name_snapshot: "note",
      label_snapshot: null,
      position: 0n,
    },
  ]);
}

function expectedLinkRows(workspace: string, revisionId: string, urls: string[]): string[] {
  return stable(
    urls.map((url, index) => {
      const prepared = targetOp(workspace, "url", obj({ url }));
      return {
        workspace_name: workspace,
        revision_id: revisionId,
        position: BigInt(index),
        relation: "supports",
        target_kind: "url",
        target: prepared.target_json,
        target_key: prepared.target_key,
        excerpt: null,
        content_hash: null,
        captured_at: null,
        capture_status: "locator_only",
        note: null,
      };
    }),
  );
}

/** The URLs each fixture revision cites, authored alongside its snapshot. */
const FIRST_URLS = ["https://example.invalid/a", "https://example.invalid/b"];

// ── child harness ───────────────────────────────────────────────────────────

type Boundary =
  | "before_delete"
  | "after_delete"
  | "after_delete_readback"
  | "before_write"
  | "after_term_write"
  | "after_link_write"
  | "after_readback";

type Facade = "evidence" | "publication" | "taxonomy" | "context";
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

const CLOCK_MS = 1_789_930_000_000;
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
    revisionIds: Array.from({ length: 12 }, () => id21("Rev")),
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

async function launch(spec: Plan, tag: string, script = EVIDENCE_CHILD): Promise<Child> {
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
      if (event.event === "parked" || event.event === "pre_emit" || event.event === "post_emit") break;
    }
    await child.killAndReap();
    // -1 records that the parent ended it, rather than pretending it completed.
    return { events, exitCode: -1, stderr: child.stderr() };
  } finally {
    await child.killAndReap();
  }
}

function trace(result: Run): { name: string; n: number }[] {
  return result.events.filter((e) => e.event === "boundary").map((e) => ({ name: e.name, n: e.n }));
}

/** Occurrence-numbered expectation, built from the contract's literal rules. */
function traceOf(spec: { deleteTable?: "term" | "link"; rows: ("term" | "link")[] }[]): { name: string; n: number }[] {
  const counts: Record<string, number> = {};
  const next = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return { name, n: counts[name]! };
  };
  const out: { name: string; n: number }[] = [];
  for (const table of spec) {
    if (table.deleteTable !== undefined) {
      out.push(next("before_delete"), next("after_delete"), next("after_delete_readback"));
    }
    for (const row of table.rows) {
      out.push(next("before_write"), next(row === "term" ? "after_term_write" : "after_link_write"), next("after_readback"));
    }
  }
  return out;
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
  recovery_required: "writer recovery required",
} as const;

/**
 * A THROWN error: class name AND all four wire fields.
 *
 * Code alone cannot say which envelope produced it, since the permitted codes
 * overlap; and omitting `message` is how an invented message string can pass
 * unnoticed. The fixed literal is therefore asserted too, from a local
 * constant rather than copied out of the implementation.
 */
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
  if (typeof value === "bigint" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => (entry === null ? null : String(entry)));
  return String(value);
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

const stable = (rows: Record<string, unknown>[]): string[] =>
  rows.map((row) => JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))).sort();

/** Every column of every derived row in one scope — full-row, never sampled. */
async function derivedScope(
  datasetRoot: string,
  table: "node_revision_terms" | "revision_links",
  workspace: string,
  revisionId: string,
): Promise<string[]> {
  const rows = (await rawRows(datasetRoot, table)).filter(
    (row) => row.workspace_name === workspace && row.revision_id === revisionId,
  );
  return stable(rows);
}

/** Everything OUTSIDE one scope, in both derived tables: the distractor set. */
async function distractors(datasetRoot: string, workspace: string, revisionId: string): Promise<Record<string, string[]>> {
  const outside = async (table: "node_revision_terms" | "revision_links") =>
    stable(
      (await rawRows(datasetRoot, table)).filter(
        (row) => !(row.workspace_name === workspace && row.revision_id === revisionId),
      ),
    );
  return { node_revision_terms: await outside("node_revision_terms"), revision_links: await outside("revision_links") };
}

/** The authoritative rows a materialization may never touch. */
async function authoritative(datasetRoot: string): Promise<Record<string, string[]>> {
  return {
    nodes: stable(await rawRows(datasetRoot, "nodes")),
    node_revisions: stable(await rawRows(datasetRoot, "node_revisions")),
  };
}

// ── gated mutation of derived rows, for the corrupt states ──────────────────

/**
 * Damage derived rows under the REAL gate.
 *
 * Missing, altered, duplicated and extra rows cannot be produced through the
 * service — it refuses to create them — so they are written here, holding the
 * lock a writer would hold, in this run's own disposable dataset.
 */
const DAMAGE_SOURCE = `
import json, sys

import lancedb
from arra_migrate.writer_gate import writer_gate

root = sys.argv[1]
# A with-statement, not a bare open(): discovery runs with ResourceWarning as
# an error, and a leaked handle would fail the suite for a reason unrelated to
# anything under test.
with open(sys.argv[2], encoding="utf-8") as handle:
    plan = json.load(handle)

with writer_gate(root):
    db = lancedb.connect(root)
    for item in plan:
        table = db.open_table(item["table"])
        if item["op"] == "delete":
            table.delete(item["where"])
        elif item["op"] == "update":
            result = table.update(where=item["where"], values=item["values"])
            if getattr(result, "rows_updated", 1) == 0:
                raise SystemExit("update matched no rows: " + item["where"])
        elif item["op"] == "duplicate":
            rows = table.search().where(item["where"]).limit(100).to_list()
            if not rows:
                raise SystemExit("duplicate source matched no rows: " + item["where"])
            copies = []
            for row in rows:
                copy = {k: v for k, v in row.items() if not k.startswith("_")}
                copy.update(item.get("values", {}))
                copies.append(copy)
            table.add(copies)
        else:
            raise SystemExit("unknown op: " + item["op"])
print(json.dumps({"ok": True}))
`;

type Damage =
  | { op: "delete"; table: string; where: string }
  | { op: "update"; table: string; where: string; values: Record<string, unknown> }
  | { op: "duplicate"; table: string; where: string; values?: Record<string, unknown> };

async function damage(datasetRoot: string, items: Damage[]): Promise<void> {
  const dir = await scratchDir("damage");
  const planPath = join(dir, "damage.json");
  await writeFile(planPath, JSON.stringify(items), "utf8");
  const result = await runOwnedChild(PYTHON, ["-c", DAMAGE_SOURCE, datasetRoot, planPath]);
  if (result.code !== 0) throw new Error(`gated damage failed (${result.code}): ${result.stderr.slice(0, 400)}`);
}

// ── locking a table tree, for the real SDK failure ──────────────────────────

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

// ── a published fixture: two workspaces, two revisions, real snapshots ──────

type Fixture = {
  root: string;
  seeded: Record<string, Seeded>;
  nodeId: string;
  revisionId: string;
  otherRevisionId: string;
  otherWorkspaceRevisionId: string;
  otherWorkspaceNodeId: string;
  /** Present only when requested: an accepted revision citing NOTHING. */
  emptyLinkRevisionId?: string;
};

const reconcileStep = (workspace: string, nodeId: string, revisionId: string): Step => ({
  facade: "evidence",
  method: "reconcileRevisionAssociations",
  request: { workspace_name: workspace, node_id: nodeId, revision_id: revisionId },
});

/**
 * Build the dataset every case starts from.
 *
 * Two workspaces each with reserved taxonomy, a node with two accepted
 * revisions in the first and one in the second. The extra revisions exist so a
 * rebuild has real distractors to preserve — a fixture with a single revision
 * cannot show that a scoped delete stayed scoped.
 */
async function publishedFixture(tag: string, options: { emptyLinks?: boolean } = {}): Promise<Fixture> {
  const created = await createTaxonomyFixture([WORKSPACE, OTHER_WORKSPACE]);
  createdRoots.push({ path: created.datasetRoot, kind: "dataset", cleanup: created.cleanup });
  const root = created.datasetRoot;

  const seeded: Record<string, Seeded> = {};
  const steps: Step[] = [];
  for (const workspace of [WORKSPACE, OTHER_WORKSPACE]) {
    const entry: Seeded = { typeVocabulary: id21("Vocab"), noteTerm: id21("Note") };
    seeded[workspace] = entry;
    steps.push({
      facade: "taxonomy",
      method: "seedReservedVocabularies",
      request: seedRequest(workspace, entry, {
        conclusion: id21("Term"),
        learning: id21("Term"),
        discussion: id21("Term"),
        correction: id21("Term"),
        horizonVocabulary: id21("Vocab"),
        short_term: id21("Term"),
        long_term: id21("Term"),
      }),
    });
  }

  const nodeId = id21("Node");
  const otherNodeId = id21("Node");
  steps.push({
    facade: "publication",
    method: "publishRevision",
    request: { operation_id: `op-${tag}-first`, content: revisionContent(WORKSPACE, nodeId, seeded[WORKSPACE]!) },
  });
  const seedRun = await run(plan(root, steps), `${tag}-seed`);
  for (let i = 0; i < steps.length; i++) expect(stepResult(seedRun, i).ok).toBe(true);
  const firstRevisionId = okValue(seedRun, steps.length - 1).revision_id as string;

  // A second accepted revision on the same node, and one in the other
  // workspace: both are distractor sources for every rebuild below.
  const followUps: Step[] = [
    {
      facade: "publication",
      method: "publishRevision",
      request: {
        operation_id: `op-${tag}-second`,
        content: revisionContent(WORKSPACE, nodeId, seeded[WORKSPACE]!, {
          base: firstRevisionId,
          title: "second",
          urls: ["https://example.invalid/c"],
        }),
      },
    },
    {
      facade: "publication",
      method: "publishRevision",
      request: {
        operation_id: `op-${tag}-other-ws`,
        content: revisionContent(OTHER_WORKSPACE, otherNodeId, seeded[OTHER_WORKSPACE]!, {
          urls: ["https://example.invalid/d"],
        }),
      },
    },
  ];
  const followUpRun = await run(plan(root, followUps), `${tag}-seed2`);
  const otherRevisionId = okValue(followUpRun, 0).revision_id as string;
  const otherWorkspaceRevisionId = okValue(followUpRun, 1).revision_id as string;

  // Materialize the distractor scopes so they exist as real derived rows,
  // written by the materializer rather than planted by a fixture.
  const materialized = await run(
    plan(root, [
      reconcileStep(WORKSPACE, nodeId, otherRevisionId),
      reconcileStep(OTHER_WORKSPACE, otherNodeId, otherWorkspaceRevisionId),
    ]),
    `${tag}-distractors`,
  );
  expect(okValue(materialized, 0).outcome).toBe("reconciled");
  expect(okValue(materialized, 1).outcome).toBe("reconciled");

  let emptyLinkRevisionId: string | undefined;
  if (options.emptyLinks === true) {
    // An accepted revision with an EMPTY link snapshot. Its expected derived
    // link set is zero rows, which is a different case from "not materialized
    // yet" and the only way to exercise a rebuild that appends nothing.
    const emptyRun = await run(
      plan(root, [
        {
          facade: "publication",
          method: "publishRevision",
          request: {
            operation_id: `op-${tag}-empty-links`,
            content: revisionContent(WORKSPACE, nodeId, seeded[WORKSPACE]!, {
              base: otherRevisionId,
              title: "cites nothing",
              urls: [],
            }),
          },
        },
      ]),
      `${tag}-seed3`,
    );
    emptyLinkRevisionId = okValue(emptyRun, 0).revision_id as string;
  }

  return {
    root,
    seeded,
    nodeId,
    revisionId: firstRevisionId,
    otherRevisionId,
    otherWorkspaceRevisionId,
    otherWorkspaceNodeId: otherNodeId,
    emptyLinkRevisionId,
  };
}

// ── A. the four reconciliation shapes ───────────────────────────────────────

recoveryTest("A1 first materialization then replay: reconciled with row triples, then silent already_satisfied", async () => {
  const fixture = await publishedFixture("a1");
  const first = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "a1-first");
  const result = okValue(first);
  expect(result.outcome).toBe("reconciled");
  expect(result.terms).toEqual({ action: "filled", count: "1" });
  expect(result.links).toEqual({ action: "filled", count: "2" });
  // One term row then two link rows, all term boundaries before any link one.
  expect(trace(first)).toEqual(traceOf([{ rows: ["term"] }, { rows: ["link", "link"] }]));

  // Independent expectations: the complete rows this file authored, not the
  // rows the materializer just produced.
  const terms = expectedTermRows(WORKSPACE, fixture.revisionId, fixture.seeded[WORKSPACE]!);
  const links = expectedLinkRows(WORKSPACE, fixture.revisionId, FIRST_URLS);
  expect(await derivedScope(fixture.root, "node_revision_terms", WORKSPACE, fixture.revisionId)).toEqual(terms);
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(links);

  const replay = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "a1-replay");
  const again = okValue(replay);
  expect(again.outcome).toBe("already_satisfied");
  expect(again.terms).toEqual({ action: "unchanged", count: "1" });
  expect(again.links).toEqual({ action: "unchanged", count: "2" });
  // Unchanged is silent: no boundary at all.
  expect(trace(replay)).toEqual([]);
  expect(await derivedScope(fixture.root, "node_revision_terms", WORKSPACE, fixture.revisionId)).toEqual(terms);
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(links);
});

recoveryTest("A2 a missing link row is FILLED: one row triple, matching rows byte-identical", async () => {
  const fixture = await publishedFixture("a2");
  await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "a2-materialize");
  const before = expectedLinkRows(WORKSPACE, fixture.revisionId, FIRST_URLS);
  const keptTerms = expectedTermRows(WORKSPACE, fixture.revisionId, fixture.seeded[WORKSPACE]!);
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(before);

  await damage(fixture.root, [
    {
      op: "delete",
      table: "revision_links",
      where: `workspace_name = '${WORKSPACE}' AND revision_id = '${fixture.revisionId}' AND position = 1`,
    },
  ]);
  expect((await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).length).toBe(1);

  const filled = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "a2-fill");
  const result = okValue(filled);
  expect(result.outcome).toBe("reconciled");
  expect(result.terms).toEqual({ action: "unchanged", count: "1" });
  expect(result.links).toEqual({ action: "filled", count: "2" });
  // A fill emits row triples only — never a delete triple.
  expect(trace(filled)).toEqual(traceOf([{ rows: ["link"] }]));
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(before);
  expect(await derivedScope(fixture.root, "node_revision_terms", WORKSPACE, fixture.revisionId)).toEqual(keptTerms);
});

recoveryTest("A3 a corrupted link field is REBUILT: delete triple then every row, distractors untouched", async () => {
  const fixture = await publishedFixture("a3");
  await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "a3-materialize");
  const expectedLinks = expectedLinkRows(WORKSPACE, fixture.revisionId, FIRST_URLS);
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(expectedLinks);
  const untouched = await distractors(fixture.root, WORKSPACE, fixture.revisionId);
  const snapshots = await authoritative(fixture.root);

  await damage(fixture.root, [
    {
      op: "update",
      table: "revision_links",
      where: `workspace_name = '${WORKSPACE}' AND revision_id = '${fixture.revisionId}' AND position = 0`,
      values: { capture_status: "captured" },
    },
  ]);

  const rebuilt = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "a3-rebuild");
  const result = okValue(rebuilt);
  expect(result.outcome).toBe("reconciled");
  expect(result.terms).toEqual({ action: "unchanged", count: "1" });
  expect(result.links).toEqual({ action: "rebuilt", count: "2" });
  expect(trace(rebuilt)).toEqual(traceOf([{ deleteTable: "link", rows: ["link", "link"] }]));

  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(expectedLinks);
  // Full-column distractor preservation across another revision AND another
  // workspace. Sampling two rows would not have shown this.
  expect(await distractors(fixture.root, WORKSPACE, fixture.revisionId)).toEqual(untouched);
  expect(await authoritative(fixture.root)).toEqual(snapshots);
});

recoveryTest("A4 MIXED: terms filled and links rebuilt, with every term boundary before any link boundary", async () => {
  const fixture = await publishedFixture("a4");
  await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "a4-materialize");
  const expectedTerms = expectedTermRows(WORKSPACE, fixture.revisionId, fixture.seeded[WORKSPACE]!);
  const expectedLinks = expectedLinkRows(WORKSPACE, fixture.revisionId, FIRST_URLS);
  const untouched = await distractors(fixture.root, WORKSPACE, fixture.revisionId);

  await damage(fixture.root, [
    {
      op: "delete",
      table: "node_revision_terms",
      where: `workspace_name = '${WORKSPACE}' AND revision_id = '${fixture.revisionId}'`,
    },
    {
      op: "duplicate",
      table: "revision_links",
      where: `workspace_name = '${WORKSPACE}' AND revision_id = '${fixture.revisionId}' AND position = 0`,
    },
  ]);

  const mixed = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "a4-mixed");
  const result = okValue(mixed);
  expect(result.terms).toEqual({ action: "filled", count: "1" });
  expect(result.links).toEqual({ action: "rebuilt", count: "2" });
  // The term row triple comes first, then the link delete triple, then the
  // link rows. This ordering is the reason the case exists.
  expect(trace(mixed)).toEqual(traceOf([{ rows: ["term"] }, { deleteTable: "link", rows: ["link", "link"] }]));
  expect(await derivedScope(fixture.root, "node_revision_terms", WORKSPACE, fixture.revisionId)).toEqual(expectedTerms);
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(expectedLinks);
  expect(await distractors(fixture.root, WORKSPACE, fixture.revisionId)).toEqual(untouched);
});

// ── B. crashes: delete, between appends, readback, lost ACK ─────────────────

for (const crash of [
  // Each park names the durable PREFIX it must leave behind, and therefore the
  // rows a retry still has to write. Comparing a retry to an earlier
  // materializer run would only prove the two agreed with each other.
  { label: "after the delete", park: { name: "after_delete" as const, n: 1 }, durableLinks: 0 },
  { label: "at the first row readback", park: { name: "after_readback" as const, n: 1 }, durableLinks: 1 },
  { label: "before the last append", park: { name: "before_write" as const, n: 2 }, durableLinks: 1 },
] as const) {
  recoveryTest(`B1 a kill ${crash.label} of a rebuild leaves an exact prefix and retries only what is missing`, async () => {
    const fixture = await publishedFixture(`b1-${crash.park.name}`);
    await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "b1-materialize");
    const expectedLinks = expectedLinkRows(WORKSPACE, fixture.revisionId, FIRST_URLS);
    const expectedTerms = expectedTermRows(WORKSPACE, fixture.revisionId, fixture.seeded[WORKSPACE]!);
    const untouched = await distractors(fixture.root, WORKSPACE, fixture.revisionId);
    const snapshots = await authoritative(fixture.root);

    // Corrupt one link field so the links table takes the REBUILD path.
    await damage(fixture.root, [
      {
        op: "update",
        table: "revision_links",
        where: `workspace_name = '${WORKSPACE}' AND revision_id = '${fixture.revisionId}' AND position = 0`,
        values: { relation: "contradicts" },
      },
    ]);

    const killed = await runAndKillAtPark(
      plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)], { parkAt: crash.park }),
      "b1-crash",
    );
    expect(killed.events.at(-1)?.event).toBe("parked");
    expect(killed.events.some((event) => event.event === "step_result")).toBe(false);

    // The durable prefix is an exact identity set, not a count: the delete has
    // run, so whatever survives must be the first `durableLinks` authored rows.
    const prefix = await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId);
    expect(prefix).toEqual(expectedLinkRows(WORKSPACE, fixture.revisionId, FIRST_URLS.slice(0, crash.durableLinks)));
    // Terms were never damaged, so they are untouched throughout.
    expect(await derivedScope(fixture.root, "node_revision_terms", WORKSPACE, fixture.revisionId)).toEqual(expectedTerms);
    expect(await authoritative(fixture.root)).toEqual(snapshots);
    expect(await distractors(fixture.root, WORKSPACE, fixture.revisionId)).toEqual(untouched);

    const retry = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "b1-retry");
    const result = okValue(retry);
    expect(result.outcome).toBe("reconciled");
    // What is left is a matching subset, so the retry FILLS the remainder and
    // emits triples only for the rows it actually writes.
    expect(result.terms).toEqual({ action: "unchanged", count: "1" });
    expect(result.links).toEqual({ action: "filled", count: "2" });
    expect(trace(retry)).toEqual(
      traceOf([{ rows: Array.from({ length: FIRST_URLS.length - crash.durableLinks }, () => "link" as const) }]),
    );

    expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(expectedLinks);
    expect(await distractors(fixture.root, WORKSPACE, fixture.revisionId)).toEqual(untouched);
  });
}

recoveryTest("B2 a lost ACK leaves the work durable and replays as already_satisfied", async () => {
  const fixture = await publishedFixture("b2");
  const killed = await runAndKillAtPark(
    plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)], {
      emitPark: "before_response_emission",
    }),
    "b2-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("pre_emit");
  expect(killed.events.some((event) => event.event === "step_result")).toBe(false);
  const terms = expectedTermRows(WORKSPACE, fixture.revisionId, fixture.seeded[WORKSPACE]!);
  const links = expectedLinkRows(WORKSPACE, fixture.revisionId, FIRST_URLS);
  // The work really was durable before the ACK was lost.
  expect(await derivedScope(fixture.root, "node_revision_terms", WORKSPACE, fixture.revisionId)).toEqual(terms);
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(links);

  const replay = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "b2-replay");
  const result = okValue(replay);
  expect(result.outcome).toBe("already_satisfied");
  expect(trace(replay)).toEqual([]);
  expect(await derivedScope(fixture.root, "node_revision_terms", WORKSPACE, fixture.revisionId)).toEqual(terms);
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(links);
});

// ── C. reads while the materializer is parked mid-rebuild ───────────────────

recoveryTest("C1 a gateless reader mid-rebuild returns byte-identical associations", async () => {
  const fixture = await publishedFixture("c1");
  await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "c1-materialize");

  const request = { workspace_name: WORKSPACE, node_id: fixture.nodeId, revision_id: fixture.revisionId };
  const before = await readAssociations(fixture.root, request, "c1-before");
  const snapshots = await authoritative(fixture.root);

  await damage(fixture.root, [
    {
      op: "update",
      table: "revision_links",
      where: `workspace_name = '${WORKSPACE}' AND revision_id = '${fixture.revisionId}' AND position = 1`,
      values: { note: "not from the snapshot" },
    },
  ]);

  // Park AFTER the delete: the derived rows for this revision are gone from
  // the table while a separate process reads. The read must still be complete,
  // because it derives from the snapshot rather than from the projection.
  const child = await launch(
    plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)], {
      parkAt: { name: "after_delete", n: 1 },
      resumeOnStdin: true,
    }),
    "c1-parked",
  );
  try {
    for (;;) {
      const event = await child.nextEvent();
      if (event.event === "parked") break;
    }
    // The projection really is empty for this scope at this moment.
    expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual([]);

    const during = await readAssociations(fixture.root, request, "c1-during");
    expect(during).toEqual(before);
    expect(await authoritative(fixture.root)).toEqual(snapshots);

    child.resume();
    child.endInput();
    for (;;) {
      const event = await child.nextEvent();
      if (event.event === "done") break;
    }
    expect(await child.waitForExit()).toBe(0);
  } finally {
    await child.killAndReap();
  }

  const after = await readAssociations(fixture.root, request, "c1-after");
  expect(after).toEqual(before);
});

/** Read through a separate gateless process, as a real cross-process reader. */
async function readAssociations(datasetRoot: string, request: Record<string, unknown>, tag: string): Promise<unknown> {
  const dir = await scratchDir(tag);
  const planPath = join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify({ datasetRoot, serviceModule: SERVICE_MODULE, request }), "utf8");
  const result = await runOwnedChild(process.execPath, [READER_CHILD, planPath]);
  if (result.code !== 0) throw new Error(`reader child failed (${result.code}): ${result.stderr.slice(0, 400)}`);
  const line = result.stdout.trim().split("\n").at(-1);
  if (line === undefined) throw new Error(`reader child printed nothing: ${result.stderr.slice(0, 400)}`);
  const parsed = JSON.parse(line);
  if (!parsed.ok) throw new Error(`read failed: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

// ── D. failure classes, told apart by owner state ───────────────────────────

recoveryTest("D1 a safe PRE-WRITE refusal leaves the owner usable", async () => {
  const fixture = await publishedFixture("d1");
  // A revision id that is not on this node's accepted ancestry: refused before
  // any derived row is touched.
  const ghost = id21("Ghost");
  const result = await run(
    plan(fixture.root, [
      reconcileStep(WORKSPACE, fixture.nodeId, ghost),
      reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId),
    ]),
    "d1",
  );

  expectThrown(errorOf(result, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "invalid_reference",
    path: "/revision_id",
  });
  // Nothing was attempted, so the SAME owner still serves the next request.
  expect(okValue(result, 1).outcome).toBe("reconciled");
  expect(trace(result)).toEqual(traceOf([{ rows: ["term"] }, { rows: ["link", "link"] }]));
});

recoveryTest("D2 a hook failure AFTER an attempted write poisons the owner", async () => {
  const fixture = await publishedFixture("d2");
  await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "d2-materialize");
  const untouched = await distractors(fixture.root, WORKSPACE, fixture.revisionId);

  // Remove the term row so the next reconcile really writes one, and arm the
  // hook to fail immediately AFTER that write lands.
  await damage(fixture.root, [
    {
      op: "delete",
      table: "node_revision_terms",
      where: `workspace_name = '${WORKSPACE}' AND revision_id = '${fixture.revisionId}'`,
    },
  ]);

  const poisoned = await run(
    plan(
      fixture.root,
      [
        reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId),
        reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId),
      ],
      { throwAt: { name: "after_term_write", n: 1 } },
    ),
    "d2",
  );

  expectThrown(errorOf(poisoned, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
  // The second request never runs on that owner. The only thing separating
  // this case from D1 is the owner state afterwards, not the result shape.
  expectThrown(errorOf(poisoned, 1), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
  // The attempted row stays durable — no rollback is claimed or performed —
  // and nothing outside the scope moved.
  expect((await derivedScope(fixture.root, "node_revision_terms", WORKSPACE, fixture.revisionId)).length).toBe(1);
  expect(await distractors(fixture.root, WORKSPACE, fixture.revisionId)).toEqual(untouched);

  // A fresh owner still converges.
  const fresh = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "d2-fresh");
  expect(okValue(fresh).outcome).toBe("already_satisfied");
});

// ── E. a real SDK failure, repaired before the second call ──────────────────

recoveryTest("E1 a real SDK failure poisons, and a REPAIRED table does not un-poison the owner", async () => {
  const fixture = await publishedFixture("e1");
  const table = join(fixture.root, "node_revision_terms.lance");
  const snapshots = await authoritative(fixture.root);

  // Commanded end to end, so the repair is provably between the two requests:
  // park before the first append -> LOCK -> release -> real SDK failure ->
  // park with the result reported -> REPAIR and prove writable -> release ->
  // second request on the SAME owner. A repair in `finally` would let both
  // requests run against a broken table and prove nothing.
  const child = await launch(
    plan(
      fixture.root,
      [
        reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId),
        reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId),
      ],
      { parkAt: { name: "before_write", n: 1 }, emitPark: "after_response_emission", resumeOnStdin: true },
    ),
    "e1",
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
  expect(exitCode).toBe(0); // measured, not constructed
  expect(observed).toEqual(["ready", "parked", "step_result", "post_emit", "repaired", "step_result", "done"]);

  expectThrown(errorOf(result, 0), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
  // Repaired filesystem, same owner, still refused.
  expectThrown(errorOf(result, 1), {
    name: "PublicationError",
    version: PUBLICATION_ENVELOPE,
    code: "recovery_required",
    path: "",
  });
  expect(await authoritative(fixture.root)).toEqual(snapshots);

  // A fresh owner proves the dataset is usable and converges the scope.
  const fresh = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "e1-fresh");
  expect(okValue(fresh).outcome).toBe("reconciled");
  expect((await derivedScope(fixture.root, "node_revision_terms", WORKSPACE, fixture.revisionId)).length).toBe(1);
});

// ── G. term-table replacement, empty expectations, oversized corruption ────

recoveryTest("G1 a kill after the TERM delete leaves that table empty and a fresh owner refills it", async () => {
  const fixture = await publishedFixture("g1");
  await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "g1-materialize");
  const expectedTerms = expectedTermRows(WORKSPACE, fixture.revisionId, fixture.seeded[WORKSPACE]!);
  const expectedLinks = expectedLinkRows(WORKSPACE, fixture.revisionId, FIRST_URLS);
  const untouched = await distractors(fixture.root, WORKSPACE, fixture.revisionId);
  const snapshots = await authoritative(fixture.root);

  // Corrupt a snapshot-derived term field so the TERM table takes the rebuild
  // path. Until now every crash case rebuilt links; the delete triple fires
  // per table, so the term table needs its own fault.
  await damage(fixture.root, [
    {
      op: "update",
      table: "node_revision_terms",
      where: `workspace_name = '${WORKSPACE}' AND revision_id = '${fixture.revisionId}'`,
      values: { term_name_snapshot: "not-the-snapshot-name" },
    },
  ]);

  const killed = await runAndKillAtPark(
    plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)], {
      parkAt: { name: "after_delete", n: 1 },
    }),
    "g1-crash",
  );
  expect(killed.events.at(-1)?.event).toBe("parked");
  // The first delete triple belongs to the TERM table, because terms are
  // processed first — so this park is after the term rows are gone and before
  // anything is appended.
  expect(await derivedScope(fixture.root, "node_revision_terms", WORKSPACE, fixture.revisionId)).toEqual([]);
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(expectedLinks);
  expect(await authoritative(fixture.root)).toEqual(snapshots);
  expect(await distractors(fixture.root, WORKSPACE, fixture.revisionId)).toEqual(untouched);

  const retry = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "g1-retry");
  const result = okValue(retry);
  expect(result.outcome).toBe("reconciled");
  // An empty scope is a matching subset of size zero, so the retry FILLS it.
  expect(result.terms).toEqual({ action: "filled", count: "1" });
  expect(result.links).toEqual({ action: "unchanged", count: "2" });
  expect(trace(retry)).toEqual(traceOf([{ rows: ["term"] }]));
  expect(await derivedScope(fixture.root, "node_revision_terms", WORKSPACE, fixture.revisionId)).toEqual(expectedTerms);
  expect(await distractors(fixture.root, WORKSPACE, fixture.revisionId)).toEqual(untouched);
});

recoveryTest("G2 a revision citing NOTHING with spurious derived rows rebuilds to empty: delete triple, no appends", async () => {
  const fixture = await publishedFixture("g2", { emptyLinks: true });
  const revisionId = fixture.emptyLinkRevisionId!;
  const first = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, revisionId)]), "g2-materialize");
  const materialized = okValue(first);
  expect(materialized.terms).toEqual({ action: "filled", count: "1" });
  // Nothing expected and nothing present: unchanged, and silent.
  expect(materialized.links).toEqual({ action: "unchanged", count: "0" });
  expect(trace(first)).toEqual(traceOf([{ rows: ["term"] }]));
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, revisionId)).toEqual([]);

  const untouched = await distractors(fixture.root, WORKSPACE, revisionId);
  // Plant a link row in a scope whose accepted snapshot cites nothing: copied
  // from another revision and re-scoped, so it is structurally plausible and
  // still has no business existing.
  //
  // The source must be a scope this case actually materialized. `revisionId`
  // above is the empty-link revision and `fixture.revisionId` is never
  // materialized here, so copying from it found nothing and the gated probe
  // refused rather than planting silently. `otherRevisionId` IS materialized
  // during fixture setup.
  await damage(fixture.root, [
    {
      op: "duplicate",
      table: "revision_links",
      where: `workspace_name = '${WORKSPACE}' AND revision_id = '${fixture.otherRevisionId}' AND position = 0`,
      values: { revision_id: revisionId },
    },
  ]);
  expect((await derivedScope(fixture.root, "revision_links", WORKSPACE, revisionId)).length).toBe(1);

  const rebuilt = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, revisionId)]), "g2-rebuild");
  const result = okValue(rebuilt);
  expect(result.outcome).toBe("reconciled");
  expect(result.terms).toEqual({ action: "unchanged", count: "1" });
  expect(result.links).toEqual({ action: "rebuilt", count: "0" });
  // A zero-row rebuild still fires the delete triple, and fires NOTHING else:
  // no append boundary can exist when no row is expected.
  expect(trace(rebuilt)).toEqual(traceOf([{ deleteTable: "link", rows: [] }]));
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, revisionId)).toEqual([]);
  expect(await distractors(fixture.root, WORKSPACE, revisionId)).toEqual(untouched);
});

recoveryTest("G3 more corrupt rows than the expected+1 lookahead still rebuilds to exactly the authored set", async () => {
  const fixture = await publishedFixture("g3");
  await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "g3-materialize");
  const expectedLinks = expectedLinkRows(WORKSPACE, fixture.revisionId, FIRST_URLS);
  const untouched = await distractors(fixture.root, WORKSPACE, fixture.revisionId);
  const snapshots = await authoritative(fixture.root);

  // Two rows are expected, so a bounded pre-read of expected+1 sees three. Six
  // extra rows put the real set far beyond that bound, which is the case where
  // a delete count can only be compared as a LOWER bound — an implementation
  // that asserted equality against its pre-read would be wrong here.
  await damage(
    fixture.root,
    [5, 6, 7, 8, 9, 10].map((position) => ({
      op: "duplicate" as const,
      table: "revision_links",
      where: `workspace_name = '${WORKSPACE}' AND revision_id = '${fixture.revisionId}' AND position = 0`,
      values: { position },
    })),
  );
  expect((await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).length).toBe(8);

  const rebuilt = await run(plan(fixture.root, [reconcileStep(WORKSPACE, fixture.nodeId, fixture.revisionId)]), "g3-rebuild");
  const result = okValue(rebuilt);
  expect(result.outcome).toBe("reconciled");
  expect(result.links).toEqual({ action: "rebuilt", count: "2" });
  expect(trace(rebuilt)).toEqual(traceOf([{ deleteTable: "link", rows: ["link", "link"] }]));
  // The whole oversized set is gone and exactly the authored rows remain.
  expect(await derivedScope(fixture.root, "revision_links", WORKSPACE, fixture.revisionId)).toEqual(expectedLinks);
  expect(await distractors(fixture.root, WORKSPACE, fixture.revisionId)).toEqual(untouched);
  expect(await authoritative(fixture.root)).toEqual(snapshots);
});

// ── F. the parent's own bounds are refutable ────────────────────────────────

recoveryTest("F1 the parent deadline fires: a silent child is killed and reaped", async () => {
  const created = await createTaxonomyFixture([WORKSPACE]);
  createdRoots.push({ path: created.datasetRoot, kind: "dataset", cleanup: created.cleanup });
  const child = await launch(plan(created.datasetRoot, []), "f1", SILENT_CHILD);
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
  // strict upper bound would be a flaky claim under scheduling jitter.
  expect(elapsedMs).toBeGreaterThan(configuredMs * 0.9);
  expect(elapsedMs).toBeLessThan(30_000);
  await child.killAndReap(5_000);
  // The silent child never wrote anything, which is also what makes it safe
  // to kill at any moment.
  expect(await rawRows(created.datasetRoot, "node_revision_terms")).toEqual([]);
  expect(await rawRows(created.datasetRoot, "revision_links")).toEqual([]);
});
