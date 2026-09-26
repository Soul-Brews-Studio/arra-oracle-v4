/**
 * #26 publication precision — physical timestamps and Int64 ordinals.
 *
 * Contract: `app/docs/contracts/revision-publication-v1.md`
 * SHA256 387272dc8655319f877ef2bb4926caf0127c3712373b1309084e2d00172a9f9c
 * (§2 "multiply millisecond integer by 1000 without floating-point rounding",
 * §4 ordinal rules, §9 "exact-millisecond and non-millisecond timestamp round
 * trips; Int64 ordinal bounds").
 *
 * Everything here goes through the SERVICE — `publishRevision`,
 * `getAcceptedHead`, `listAcceptedHistory` — and is then confirmed against RAW
 * Arrow storage. Exercising `rows.ts` alone would only prove that a pure
 * function agrees with itself; the claim under test is that a value survives a
 * real write, a real process boundary and a real read.
 *
 * Deliberately bounded claims:
 *
 * * These are SPECIFIC values at specific boundaries — an ordinary instant,
 *   the year-9999 maximum, one microsecond past each — not a proof that every
 *   representable timestamp round trips.
 * * The Int64 cases prove that invalid STORED ordinals fail closed and that
 *   legitimate ordinals travel as canonical decimal text. They do NOT
 *   construct a valid chain at the Int64 ceiling: §4 requires ordinals to be
 *   exactly 1..n with the first having a null base, so a chain reaching
 *   `2^63-1` cannot exist without violating contiguity. A fabricated one would
 *   be testing a state the contract forbids, so the ceiling is exercised as a
 *   rejected stored value and the arithmetic limit is left explicitly
 *   untested rather than faked.
 * * Writes happen only in fresh, owned, disposable datasets created by the
 *   sanctioned fixture creator. No existing data, no network, no model.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@lancedb/lancedb";
import {
  PYTHON,
  createFixture,
  encodeRequest,
  idSource,
  revisionEnvelope,
  runGated,
  runOwnedChild,
  type SeededWorkspace,
} from "../../helpers/publication-fixture";
import { testTimeout } from "../../helpers/timing.testTimeout";

// ── dependencies ────────────────────────────────────────────────────────────

const SERVER_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const SERVICE_MODULE = join(SERVER_DIR, "src/publication/service.ts");
const PY_SRC = fileURLToPath(new URL("../../../../migrate-py/src", import.meta.url));
const FIXTURE_CREATOR = fileURLToPath(
  new URL("../../../../migrate-py/tests/export_publication_fixture.py", import.meta.url),
);

const MISSING: string[] = [
  [PYTHON, "python interpreter (set ARRA_CONTRACT_PYTHON)"],
  [join(PY_SRC, "arra_migrate/writer_gate.py"), "arra_migrate.writer_gate"],
  [FIXTURE_CREATOR, "export_publication_fixture.py"],
  [SERVICE_MODULE, "src/publication/service.ts"],
]
  .filter(([path]) => !existsSync(path!))
  .map(([, label]) => label!);

const PENDING = MISSING.length > 0;
const reason = PENDING ? ` [PENDING: ${MISSING.join(", ")}]` : "";
/** Each case creates a dataset and runs real gated children; 5s is not enough. */
const CASE_TIMEOUT_MS = testTimeout(180_000);
type CaseBody = () => void | Promise<unknown>;
const precisionTest = PENDING
  ? (name: string, fn: CaseBody) => test.skip(name + reason, fn, CASE_TIMEOUT_MS)
  : (name: string, fn: CaseBody) => test(name, fn, CASE_TIMEOUT_MS);

test("preflight: every dependency the precision suite needs is present", () => {
  // Red while pending, so a skipped case can never read as acceptance.
  expect(MISSING).toEqual([]);
});

// ── owned scratch ───────────────────────────────────────────────────────────

const scratch: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

async function scratchDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `arra-pub-precision-${tag}-`));
  scratch.push(dir);
  return dir;
}

afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshFixture(): Promise<{ root: string; workspace: string; seed: SeededWorkspace }> {
  const fixture = await createFixture(["wsA", "wsB"]);
  cleanups.push(fixture.cleanup);
  return { root: fixture.datasetRoot, workspace: "wsA", seed: fixture.workspaces.wsA! };
}

const nextId = idSource("Prc");

// ── the gated child: service calls only, network and model fail if used ─────

/**
 * The owned Bun child, as source text written into a temp dir.
 *
 * `fetch` is replaced with a thrower BEFORE the service is imported, so any
 * network access on the authoritative path fails the case instead of quietly
 * succeeding. Nothing here imports an embedding or search module; the absence
 * is also checked from the dataset side, by requiring the projection table to
 * stay empty.
 */
const CHILD_SOURCE = `
globalThis.fetch = () => { throw new Error("network dependency used on the authoritative path"); };

const plan = JSON.parse(await Bun.file(process.argv[2]).text());
const { openPublicationWriter } = await import(plan.serviceModule);

let clockIndex = 0;
let idIndex = 0;
const service = await openPublicationWriter(plan.datasetRoot, {
  clock: () => {
    const value = plan.clockMs[clockIndex];
    if (value === undefined) throw new Error("clock samples exhausted");
    clockIndex += 1;
    return value;
  },
  newRevisionId: () => {
    const value = plan.revisionIds[idIndex];
    if (value === undefined) throw new Error("revision ids exhausted");
    idIndex += 1;
    return value;
  },
});

const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
const results = [];
try {
  for (const step of plan.steps) {
    try {
      const value = step.kind === "publish"
        ? await service.publishRevision(encode({ operation_id: step.operation_id, content: step.content }))
        : step.kind === "head"
          ? await service.getAcceptedHead(encode({ workspace_name: step.workspace_name, node_id: step.node_id }))
          : await service.listAcceptedHistory(encode({ workspace_name: step.workspace_name, node_id: step.node_id }));
      results.push({ ok: true, value: value ?? null });
    } catch (error) {
      results.push({
        ok: false,
        error: typeof error?.toJSON === "function"
          ? error.toJSON()
          : { version: null, code: null, path: null, message: String(error?.message ?? error) },
      });
    }
  }
} finally {
  await service.close();
}
await Bun.write(Bun.stdout, JSON.stringify(results) + "\\n");
`;

type Step =
  | { kind: "publish"; operation_id: string; content: Record<string, unknown> }
  | { kind: "head"; workspace_name: string; node_id: string }
  | { kind: "history"; workspace_name: string; node_id: string };

type StepResult = { ok: true; value: unknown } | { ok: false; error: Record<string, unknown> };

/**
 * Run steps in one gated owner process.
 *
 * `runGated` from the shared helper carries the parent-enforced deadline and
 * kills the exact owned PID if it is exceeded, so nothing here can run
 * unbounded.
 */
async function runSteps(
  datasetRoot: string,
  steps: Step[],
  options: { clockMs?: number[]; revisionIds?: string[] } = {},
): Promise<StepResult[]> {
  const dir = await scratchDir("child");
  const childPath = join(dir, "precision-child.ts");
  const planPath = join(dir, "plan.json");
  await writeFile(childPath, CHILD_SOURCE, "utf8");
  await writeFile(
    planPath,
    JSON.stringify({
      datasetRoot,
      serviceModule: SERVICE_MODULE,
      clockMs: options.clockMs ?? [1_758_000_000_000, 1_758_000_060_000],
      revisionIds: options.revisionIds ?? [nextId(), nextId()],
      steps,
    }),
    "utf8",
  );

  const result = await runGated(datasetRoot, childPath, [planPath]);
  if (result.code !== 0) throw new Error(`gated child failed (${result.code}): ${result.stderr.slice(0, 500)}`);
  const line = result.stdout.trim().split("\n").at(-1);
  if (line === undefined) throw new Error(`gated child printed nothing; stderr: ${result.stderr.slice(0, 500)}`);
  return JSON.parse(line) as StepResult[];
}

function okValue(results: StepResult[], index = 0): any {
  const result = results[index];
  if (result === undefined) throw new Error(`no result at index ${index}`);
  if (!result.ok) throw new Error(`step ${index} failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

function errorOf(results: StepResult[], index = 0): Record<string, unknown> {
  const result = results[index];
  if (result === undefined) throw new Error(`no result at index ${index}`);
  if (result.ok) throw new Error(`step ${index} unexpectedly succeeded: ${JSON.stringify(result.value)}`);
  return result.error;
}

// ── reading: scoped service, and raw Arrow underneath it ────────────────────

async function reader(datasetRoot: string) {
  const { openPublicationReader } = await import(SERVICE_MODULE);
  return (await openPublicationReader(datasetRoot)) as {
    getAcceptedHead(bytes: Uint8Array): Promise<unknown>;
    listAcceptedHistory(bytes: Uint8Array): Promise<unknown>;
  };
}

/** The contract envelope of whatever a scoped read threw. */
async function readFailure(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    const value = await fn();
    throw new Error(`expected a publication error, got ${JSON.stringify(value)}`);
  } catch (error) {
    const toJSON = (error as { toJSON?: () => Record<string, unknown> }).toJSON;
    if (typeof toJSON !== "function") throw error;
    return toJSON.call(error);
  }
}

/**
 * Read a cell from RAW storage.
 *
 * Int64 and timestamp[us] values come from the underlying BigInt64Array. The
 * row accessor would divide microseconds into a lossy Number before this test
 * could look at them, which is exactly the loss under examination.
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

async function rowCount(datasetRoot: string, table: string): Promise<number> {
  return (await rawRows(datasetRoot, table)).length;
}

// ── gate-held synthetic writes ──────────────────────────────────────────────

/**
 * Append or update rows under the REAL writer gate.
 *
 * Sub-millisecond timestamps and invalid ordinals cannot be produced through
 * the service — it refuses to create them — so they are written here, holding
 * the same lock a publisher would hold, into this file's own disposable
 * dataset.
 */
const GATED_WRITE_SOURCE = `
import json, sys
from datetime import datetime, timedelta

import lancedb
import pyarrow as pa
from arra_migrate.writer_gate import writer_gate

root = sys.argv[1]
plan = json.loads(open(sys.argv[2]).read())
EPOCH = datetime(1970, 1, 1)


def from_micros(micros):
    # Exact integer arithmetic: timedelta takes microseconds directly, so no
    # float division ever touches the value under test.
    return EPOCH + timedelta(microseconds=int(micros))


def convert(field, value):
    if value is None:
        return None
    if pa.types.is_timestamp(field.type):
        return from_micros(value)
    if pa.types.is_integer(field.type):
        return int(value)
    return value


with writer_gate(root):
    db = lancedb.connect(root)
    for item in plan:
        table = db.open_table(item["table"])
        if item["op"] == "append":
            schema = table.schema
            rows = [{f.name: convert(f, row.get(f.name)) for f in schema} for row in item["rows"]]
            table.add(pa.Table.from_pylist(rows, schema=schema))
        elif item["op"] == "set_timestamp":
            table.update(where=item["where"], values={item["column"]: from_micros(item["micros"])})
        elif item["op"] == "set_int":
            table.update(where=item["where"], values={item["column"]: int(item["value"])})
        else:
            raise SystemExit("unknown op: " + item["op"])
print(json.dumps({"ok": True}))
`;

type GatedWrite =
  | { op: "append"; table: string; rows: Record<string, unknown>[] }
  | { op: "set_timestamp"; table: string; where: string; column: string; micros: string }
  | { op: "set_int"; table: string; where: string; column: string; value: string };

async function gatedWrite(datasetRoot: string, writes: GatedWrite[]): Promise<void> {
  const dir = await scratchDir("write");
  const planPath = join(dir, "writes.json");
  await writeFile(planPath, JSON.stringify(writes), "utf8");
  const result = await runOwnedChild(PYTHON, ["-c", GATED_WRITE_SOURCE, datasetRoot, planPath]);
  if (result.code !== 0) throw new Error(`gated write failed (${result.code}): ${result.stderr.slice(0, 500)}`);
}

// ── values under test ───────────────────────────────────────────────────────

/** An ordinary instant, on a millisecond. */
const ORDINARY_MS = 1_758_000_123_000;
/** 9999-12-31T23:59:59.999Z — the last millisecond §2 admits. */
const MAX_MS = 253_402_300_799_999;
const ORDINARY_TEXT = new Date(ORDINARY_MS).toISOString();
const MAX_TEXT = new Date(MAX_MS).toISOString();
const INT64_MAX_TEXT = (2n ** 63n - 1n).toString(10);

const request = (workspace: string, nodeId: string) => encodeRequest({ workspace_name: workspace, node_id: nodeId });

// ── P1. exact milliseconds survive a real round trip ────────────────────────

precisionTest("P1 exact-millisecond created_at and non-null validity bounds survive persistence unchanged", async () => {
  const { root, workspace, seed } = await freshFixture();
  const nodeId = nextId();
  const content = revisionEnvelope(workspace, seed, nodeId, {
    valid_from: ORDINARY_TEXT,
    valid_to: MAX_TEXT,
  });

  const results = await runSteps(
    root,
    [
      { kind: "publish", operation_id: "op-p1", content },
      { kind: "head", workspace_name: workspace, node_id: nodeId },
    ],
    { clockMs: [ORDINARY_MS] },
  );

  const outcome = okValue(results, 0);
  expect(outcome.outcome).toBe("accepted");
  expect(outcome.revision_created_at).toBe(ORDINARY_TEXT);
  expect(outcome.node_created_at).toBe(ORDINARY_TEXT);

  // Through the scoped read: exact UTC millisecond text, both bounds present.
  const head = okValue(results, 1);
  expect(head.revision.created_at).toBe(ORDINARY_TEXT);
  expect(head.revision.valid_from).toBe(ORDINARY_TEXT);
  expect(head.revision.valid_to).toBe(MAX_TEXT);
  expect(head.node.created_at).toBe(ORDINARY_TEXT);
  expect(head.node.updated_at).toBe(ORDINARY_TEXT);

  // And underneath it, in physical storage: microseconds are the millisecond
  // integer times 1000 EXACTLY, held as BigInt. A float path would land a
  // fraction away and nothing above would have noticed.
  const [row] = await rawRows(root, "node_revisions");
  expect(row!.created_at).toBe(BigInt(ORDINARY_MS) * 1000n);
  expect(row!.valid_from).toBe(BigInt(ORDINARY_MS) * 1000n);
  expect(row!.valid_to).toBe(BigInt(MAX_MS) * 1000n);
  const [node] = await rawRows(root, "nodes");
  expect(node!.created_at).toBe(BigInt(ORDINARY_MS) * 1000n);
  expect(node!.updated_at).toBe(BigInt(ORDINARY_MS) * 1000n);

  // §1: no projection or search write on the authoritative path. The child
  // also fails if `fetch` is touched, so network and model are covered from
  // both sides.
  expect(await rowCount(root, "search_chunks_v1")).toBe(0);
});

precisionTest("P2 the year-9999 boundary millisecond round trips exactly", async () => {
  const { root, workspace, seed } = await freshFixture();
  const nodeId = nextId();
  const content = revisionEnvelope(workspace, seed, nodeId);

  const results = await runSteps(
    root,
    [
      { kind: "publish", operation_id: "op-p2", content },
      { kind: "history", workspace_name: workspace, node_id: nodeId },
    ],
    { clockMs: [MAX_MS] },
  );

  expect(okValue(results, 0).revision_created_at).toBe(MAX_TEXT);
  const history = okValue(results, 1);
  expect(history.revisions).toHaveLength(1);
  expect(history.revisions[0].created_at).toBe(MAX_TEXT);

  const [row] = await rawRows(root, "node_revisions");
  expect(row!.created_at).toBe(253_402_300_799_999_000n);
  // The boundary is the last representable millisecond, not an approximation
  // of it: adding one more millisecond would leave the range §2 allows.
  expect(BigInt(MAX_MS) * 1000n).toBe(253_402_300_799_999_000n);
});

// ── P3. a stored sub-millisecond value is refused, never rounded ────────────

for (const boundary of [
  { label: "an ordinary instant", baseMs: ORDINARY_MS },
  // The far-calendar case is the dangerous one: dividing 253402300799999001
  // by 1000 as a Number lands on an INTEGER, so a post-hoc integrality check
  // could not tell it apart from an exact millisecond.
  { label: "the year-9999 boundary", baseMs: MAX_MS },
] as const) {
  precisionTest(`P3 a stored created_at one microsecond past ${boundary.label} fails closed`, async () => {
    const { root, workspace, seed } = await freshFixture();
    const nodeId = nextId();
    const content = revisionEnvelope(workspace, seed, nodeId);

    const published = await runSteps(root, [{ kind: "publish", operation_id: "op-p3", content }], {
      clockMs: [boundary.baseMs],
    });
    const revisionId = okValue(published, 0).revision_id as string;

    // One microsecond past the stored millisecond, written under the gate.
    const skewed = (BigInt(boundary.baseMs) * 1000n + 1n).toString(10);
    await gatedWrite(root, [
      {
        op: "set_timestamp",
        table: "node_revisions",
        where: `id = '${revisionId}'`,
        column: "created_at",
        micros: skewed,
      },
    ]);
    const [row] = await rawRows(root, "node_revisions");
    expect(row!.created_at).toBe(BigInt(skewed));

    // Both scoped reads must refuse it rather than present a rounded value.
    const scoped = await reader(root);
    const headError = await readFailure(() => scoped.getAcceptedHead(request(workspace, nodeId)));
    expect(headError.version).toBe("arra-publication-error/v1");
    expect(headError.code).toBe("integrity_failure");
    expect(headError.message).toBe("stored state failed integrity validation");
    const historyError = await readFailure(() => scoped.listAcceptedHistory(request(workspace, nodeId)));
    expect(historyError.code).toBe("integrity_failure");

    // And a publication that would have to read that chain fails closed too,
    // appending nothing.
    const before = await rawRows(root, "node_revisions");
    const next = revisionEnvelope(workspace, seed, nodeId, { base_revision_id: revisionId, title: "next" });
    const attempted = await runSteps(root, [{ kind: "publish", operation_id: "op-p3-next", content: next }], {
      clockMs: [boundary.baseMs],
    });
    expect(errorOf(attempted, 0).code).toBe("integrity_failure");
    expect(await rawRows(root, "node_revisions")).toEqual(before);
  });
}

// ── P4. Int64 ordinals: exact text, and fail-closed on invalid stored values ─

precisionTest("P4 legitimate ordinals travel as canonical decimal text and stay exact in storage", async () => {
  const { root, workspace, seed } = await freshFixture();
  const nodeId = nextId();
  const first = revisionEnvelope(workspace, seed, nodeId);

  const firstRun = await runSteps(root, [{ kind: "publish", operation_id: "op-p4-1", content: first }], {
    clockMs: [ORDINARY_MS],
  });
  const firstId = okValue(firstRun, 0).revision_id as string;
  expect(okValue(firstRun, 0).revision_no).toBe("1");

  const second = revisionEnvelope(workspace, seed, nodeId, { base_revision_id: firstId, title: "second" });
  const secondRun = await runSteps(
    root,
    [
      { kind: "publish", operation_id: "op-p4-2", content: second },
      { kind: "history", workspace_name: workspace, node_id: nodeId },
    ],
    { clockMs: [ORDINARY_MS + 1000] },
  );
  // Decimal TEXT on the wire, per §2 — never a JS number, at either end.
  expect(okValue(secondRun, 0).revision_no).toBe("2");
  expect(typeof okValue(secondRun, 0).revision_no).toBe("string");
  const history = okValue(secondRun, 1);
  expect(history.revisions.map((row: any) => row.revision_no)).toEqual(["1", "2"]);
  expect(history.revisions.map((row: any) => row.schema_version)).toEqual(["1", "1"]);

  // BigInt in storage, not a double that happens to look right.
  const rows = await rawRows(root, "node_revisions");
  expect(rows.map((row) => row.revision_no).sort()).toEqual([1n, 2n]);
});

for (const ordinal of [
  { label: "zero", value: "0" },
  { label: "negative", value: "-1" },
  // The Int64 ceiling. §4 requires ordinals 1..n with the first base null, so
  // a VALID chain can never reach it; what is proven here is that the stored
  // value is rejected, not that increment-at-the-ceiling was exercised.
  { label: "the Int64 maximum", value: INT64_MAX_TEXT },
] as const) {
  precisionTest(`P5 a stored first ordinal of ${ordinal.label} fails closed on read and on publication`, async () => {
    const { root, workspace, seed } = await freshFixture();
    const nodeId = nextId();
    const content = revisionEnvelope(workspace, seed, nodeId);

    // A real accepted revision first, so the row is canonical in every other
    // respect and the ordinal is the only thing wrong with it.
    const published = await runSteps(root, [{ kind: "publish", operation_id: "op-p5", content }], {
      clockMs: [ORDINARY_MS],
    });
    const revisionId = okValue(published, 0).revision_id as string;

    await gatedWrite(root, [
      {
        op: "set_int",
        table: "node_revisions",
        where: `id = '${revisionId}'`,
        column: "revision_no",
        value: ordinal.value,
      },
    ]);
    const [row] = await rawRows(root, "node_revisions");
    expect(row!.revision_no).toBe(BigInt(ordinal.value));

    const scoped = await reader(root);
    const headError = await readFailure(() => scoped.getAcceptedHead(request(workspace, nodeId)));
    expect(headError.code).toBe("integrity_failure");
    const historyError = await readFailure(() => scoped.listAcceptedHistory(request(workspace, nodeId)));
    expect(historyError.code).toBe("integrity_failure");

    // Publishing the NEXT revision would have to compute predecessor+1 from
    // that stored ordinal. It must refuse before any append rather than
    // arithmetic its way past a value the contract rejects.
    const before = await rawRows(root, "node_revisions");
    const next = revisionEnvelope(workspace, seed, nodeId, { base_revision_id: revisionId, title: "next" });
    const attempted = await runSteps(root, [{ kind: "publish", operation_id: "op-p5-next", content: next }], {
      clockMs: [ORDINARY_MS + 1000],
    });
    expect(errorOf(attempted, 0).code).toBe("integrity_failure");
    expect(await rawRows(root, "node_revisions")).toEqual(before);
  });
}
