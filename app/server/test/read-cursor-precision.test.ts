/**
 * #74 read-cursor precision evidence (read-cursor-v1 §7, precision lane).
 *
 * Scope: the three distinct prior states and expected precedence; signed Int64
 * ordering across negative, 9-versus-10, gaps, beyond 2^53 and the ceiling;
 * selected duplicate identities; request grammar versus retained namespace
 * corruption as two separate oracles; raw microsecond handling and Gregorian
 * bounds; clock-free replay and conflict, regressed and equal clock, each with
 * all five physical fields and no-write table-version evidence.
 *
 * ABSENT API IS NOT GREEN EVIDENCE. At base d42ee3e9 neither `getReadCursor`
 * nor `advanceReadCursor` exists on any context facade. Every test gates on
 * their presence and fails with a legible reason; nothing is skipped, because a
 * skip would be credited as acceptance by nobody but would read as green.
 *
 * INDEPENDENT ORACLES. Every expected row is authored here as the five physical
 * fields in contract order, never taken from a first materializer output. Where
 * a governed parser message is deterministic it is asserted exactly; where the
 * accepted call site leaves text unconstrained the test says so rather than
 * inventing replacement text.
 *
 * TWO KINDS OF BAD STATE, DELIBERATELY LABELLED. A value this file writes with
 * raw Arrow is ENGINE-ADMITTED corruption: the store accepted it, so the kernel
 * must reject it on read. A value the pure encoder must refuse regardless of
 * whether any engine would store it is a PURE-ENCODER concern and belongs to
 * core's own tests. This file never infers engine enforcement from a NOT NULL
 * declaration, and says so at each site where the distinction matters.
 *
 * Bounded claims: names in requests are not authorization, a cooperative gate
 * is not storage CAS, and nothing here asserts admission, permission or
 * transport behaviour.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as service from "../src/publication/service";
import { runGated } from "./helpers/publication-fixture";
import { createTaxonomyFixture, type TaxonomyFixture } from "./helpers/taxonomy-fixture";
import { scaledMs } from "./helpers/timing.scaledMs";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/read-cursor-v1/precision/seed-child.ts", import.meta.url).pathname;
const SEED_DEADLINE_MS = scaledMs(300_000);
const TEST_TIMEOUT_MS = testTimeout(600_000);

const W1 = "alpha-workspace";
const W2 = "beta-workspace";
const PEER = "peer-a";
const SESSION = "sess-a";
const OTHER_SESSION = "sess-b";

const MICROS_PER_MS = 1000n;
const SEED_MS = 1789948800000n; // 2026-09-21T00:00:00.000Z
const SEED_MICROS = SEED_MS * MICROS_PER_MS;
const SEED_ISO = new Date(Number(SEED_MS)).toISOString();
const LATER_MS = SEED_MS + 60_000n;
const LATER_ISO = new Date(Number(LATER_MS)).toISOString();

/** The exact physical field order, quoted from §2. */
const READ_CURSOR_FIELDS = [
  "workspace_name", "peer_name", "session_name", "last_read_message_id", "last_read_at",
] as const;

/** Fixed literals, restated rather than imported. */
const SAFE = {
  invalid_request: "invalid publication request",
  invalid_reference: "invalid scoped reference",
  integrity_failure: "stored state failed integrity validation",
} as const;
const NANOID_MESSAGE = "expected a 21-character URL-safe id";

/** Matches the published helper commitment: right-pad with zeros to 21. */
const cursorId = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

function requireCursorApi(facade: Record<string, unknown>, needed: string[]): void {
  const missing = needed.filter((name) => typeof facade[name] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `read-cursor API absent: ${missing.join(", ")} not on the context facade. ` +
        "Expected from #71; these precision tests are red by construction until it lands.",
    );
  }
}

// ── request builders, mirroring the published commitments ───────────────────

const encodeRequest = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

const getRequest = (workspace: string, overrides: Record<string, unknown> = {}) =>
  ({ workspace_name: workspace, peer_name: PEER, session_name: SESSION, ...overrides });

const advanceRequest = (workspace: string, overrides: Record<string, unknown> = {}) => ({
  workspace_name: workspace,
  peer_name: PEER,
  session_name: SESSION,
  last_read_message_id: cursorId("msg1"),
  expected: null,
  ...overrides,
});

const expectedPointer = (pointer: string | null) => ({ last_read_message_id: pointer });

// ── seeds ───────────────────────────────────────────────────────────────────

type MessageSeed = {
  publicId: string;
  seq: bigint;
  id?: bigint;
  workspace?: string;
  session?: string;
};

function messageRow(seed: MessageSeed, index: number): Record<string, unknown> {
  return {
    id: (seed.id ?? BigInt(index + 1)).toString(10),
    public_id: seed.publicId,
    workspace_name: seed.workspace ?? W1,
    session_name: seed.session ?? SESSION,
    peer_name: PEER,
    content: "c",
    token_count: "0",
    seq_in_session: seed.seq.toString(10),
    created_at: SEED_MICROS.toString(10),
    ingested_at: SEED_MICROS.toString(10),
    role: null,
    in_reply_to: null,
  };
}

type CursorSeed = {
  workspace?: string;
  peer?: string;
  session?: string;
  pointer: string | null;
  micros?: bigint;
};

function cursorRow(seed: CursorSeed): Record<string, unknown> {
  return {
    workspace_name: seed.workspace ?? W1,
    peer_name: seed.peer ?? PEER,
    session_name: seed.session ?? SESSION,
    last_read_message_id: seed.pointer,
    last_read_at: (seed.micros ?? SEED_MICROS).toString(10),
  };
}

/** The five-field row this file says the service must return. */
function expectedRow(pointer: string | null, iso: string, overrides: Record<string, unknown> = {}) {
  return {
    workspace_name: W1,
    peer_name: PEER,
    session_name: SESSION,
    last_read_message_id: pointer,
    last_read_at: iso,
    ...overrides,
  };
}

function registrationSteps(
  sessions: { workspace: string; session: string; active?: boolean; left?: boolean }[],
): unknown[] {
  const workspaces = [...new Set(sessions.map((entry) => entry.workspace))];
  return [
    {
      op: "seed",
      table: "peers",
      rows: workspaces.map((workspace, index) => ({
        id: cursorId(`peer${index + 1}`),
        name: PEER,
        workspace_name: workspace,
        created_at: SEED_MICROS.toString(10),
      })),
    },
    {
      op: "seed",
      table: "sessions",
      rows: sessions.map((entry, index) => ({
        id: cursorId(`sess${index + 1}`),
        name: entry.session,
        workspace_name: entry.workspace,
        is_active: entry.active ?? true,
        created_at: SEED_MICROS.toString(10),
      })),
    },
    {
      op: "seed",
      table: "session_peers",
      rows: sessions.map((entry) => ({
        workspace_name: entry.workspace,
        session_name: entry.session,
        peer_name: PEER,
        joined_at: SEED_MICROS.toString(10),
        left_at: entry.left === true ? SEED_MICROS.toString(10) : null,
      })),
    },
  ];
}

// ── plumbing ────────────────────────────────────────────────────────────────

type ChildAction =
  | { method: string; ok: true; result: Record<string, unknown> }
  | { method: string; ok: false; name: string | null; error: Record<string, unknown> };

async function runPlan(fixture: TaxonomyFixture, steps: unknown[]): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), "arra-rc74-plan-"));
  const planPath = join(dir, "plan.json");
  try {
    await writeFile(planPath, JSON.stringify({ datasetRoot: fixture.datasetRoot, steps }), "utf8");
    const run = await runGated(fixture.datasetRoot, CHILD, [planPath], {
      deadlineMs: SEED_DEADLINE_MS,
    });
    if (run.code !== 0) {
      throw new Error(`gated seed child failed (${run.code}): ${run.stderr.slice(0, 1200)}`);
    }
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } finally {
    // Creation-record cleanup: this directory is removed because THIS call
    // created it, not because of its prefix or timestamp.
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writer calls run inside the gated child; the parent holds no gate. */
async function runCursor(
  fixture: TaxonomyFixture,
  actions: { method: string; request: unknown }[],
  clock: { mode: "fixed"; ms: number } | { mode: "throw" },
): Promise<ChildAction[]> {
  const output = await runPlan(fixture, [
    { op: "cursor", sourceNamespace: null, clock, actions },
  ]);
  const entry = (output.results as Record<string, unknown>[]).find((row) => row.op === "cursor");
  if (entry === undefined) throw new Error("child produced no cursor result");
  return entry.actions as ChildAction[];
}

/**
 * The LOSSLESS physical rows, as the store actually holds them.
 *
 * A version-and-count snapshot cannot support a five-field storage claim: an
 * `advanced` response can be exactly right while the persisted row is wrong,
 * and neither the count nor the version would move differently. Raw
 * microseconds come back as canonical decimal text.
 */
async function storedRows(
  fixture: TaxonomyFixture,
  table: string,
  predicate: string,
): Promise<Record<string, unknown>[]> {
  const output = await runPlan(fixture, [{ op: "rows", table, predicate }]);
  const entry = (output.results as Record<string, unknown>[]).find((row) => row.op === "rows");
  if (entry === undefined) throw new Error("child produced no rows result");
  return entry.rows as Record<string, unknown>[];
}

const scopeW1 = `workspace_name = '${W1}'`;

type Admission =
  | { admitted: true }
  | { admitted: false; refusal: { name: string | null; message: string } };

/**
 * Ask the store whether it will accept a value, without a broad catch.
 *
 * The child wraps ONLY its `add` call, after plan parsing, conversion and Arrow
 * construction have all succeeded, and returns a structured result. Every other
 * failure — child launch, gate, timeout, malformed plan — still surfaces as a
 * nonzero exit and a thrown `runPlan`, because reporting one of those as "the
 * engine refused the value" would be a different claim wearing this one's
 * clothes.
 */
async function probeAdmission(
  fixture: TaxonomyFixture,
  table: string,
  rows: Record<string, unknown>[],
): Promise<Admission> {
  const output = await runPlan(fixture, [{ op: "seed", table, rows, probe: true }]);
  const entry = (output.results as Record<string, unknown>[]).find((row) => row.op === "seed");
  if (entry === undefined) throw new Error("child produced no seed result");
  if (entry.admitted === true) return { admitted: true };
  const refusal = entry.refusal as { name: string | null; message: string } | undefined;
  if (refusal === undefined) throw new Error("child reported refusal without detail");
  return { admitted: false, refusal };
}

/** The five physical fields as STORED: pointer and raw micros, not rendered. */
function expectedStoredRow(pointer: string | null, micros: bigint): Record<string, unknown> {
  return {
    workspace_name: W1,
    peer_name: PEER,
    session_name: SESSION,
    last_read_message_id: pointer,
    last_read_at: micros.toString(10),
  };
}

const snapshotOf = (output: Record<string, unknown>, occurrence = 0): unknown =>
  (output.results as Record<string, unknown>[]).filter((row) => row.op === "snapshot")[occurrence]!
    .snapshot;

async function reader(fixture: TaxonomyFixture): Promise<Record<string, unknown>> {
  const api = service as unknown as Record<string, unknown>;
  const open = api.openContextReader as (root: string) => Promise<Record<string, unknown>>;
  const bundle = await open(fixture.datasetRoot);
  return bundle.context as Record<string, unknown>;
}

function okResult(action: ChildAction): Record<string, unknown> {
  if (!action.ok) throw new Error(`expected a value, child threw ${JSON.stringify(action.error)}`);
  return action.result;
}

function failure(action: ChildAction): { name: string | null; error: Record<string, unknown> } {
  if (action.ok) throw new Error(`expected a throw, child returned ${JSON.stringify(action.result)}`);
  return { name: action.name, error: action.error };
}

/** All four wire fields, plus the name on an actually thrown instance (§6). */
function expectPublicationError(
  action: ChildAction,
  code: keyof typeof SAFE,
  path: string,
): void {
  const { name, error } = failure(action);
  expect(name).toBe("PublicationError");
  expect(error).toEqual({
    version: "arra-publication-error/v1",
    code,
    path,
    message: SAFE[code],
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const marker = Symbol("no-rejection");
  let thrown: unknown = marker;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  if (thrown === marker) throw new Error("expected a rejection, got a resolved value");
  return thrown;
}

function expectThrownPublication(error: unknown, code: keyof typeof SAFE, path: string): void {
  const shaped = error as { name?: string; toJSON?: () => Record<string, unknown> };
  expect(shaped.name).toBe("PublicationError");
  expect(shaped.toJSON?.()).toEqual({
    version: "arra-publication-error/v1",
    code,
    path,
    message: SAFE[code],
  });
}

const MSG_A = cursorId("msgA");
const MSG_B = cursorId("msgB");
const MSG_C = cursorId("msgC");

/** A dataset with peer/session registered and the given messages seeded. */
async function corpus(
  messages: MessageSeed[],
  options: {
    cursors?: CursorSeed[];
    sessions?: { workspace: string; session: string; active?: boolean; left?: boolean }[];
    workspaces?: string[];
  } = {},
): Promise<TaxonomyFixture> {
  const fixture = await createTaxonomyFixture(options.workspaces ?? [W1, W2]);
  const steps: unknown[] = [
    ...registrationSteps(options.sessions ?? [{ workspace: W1, session: SESSION }]),
    { op: "seed", table: "messages", rows: messages.map(messageRow) },
  ];
  if (options.cursors !== undefined && options.cursors.length > 0) {
    steps.push({ op: "seed", table: "read_cursors", rows: options.cursors.map(cursorRow) });
  }
  await runPlan(fixture, steps);
  return fixture;
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("cursor surface", () => {
  test(
    "all four context-bearing factories carry the new methods, with no nested close",
    async () => {
      const api = service as unknown as Record<string, unknown>;
      // The nine runtime exports are unchanged by this slice (§1).
      expect(Object.keys(service).sort()).toEqual([
        "PublicationError",
        "openContextReader",
        "openContextWriter",
        "openEvidenceReader",
        "openEvidenceWriter",
        "openKnowledgeReader",
        "openKnowledgeWriter",
        "openPublicationReader",
        "openPublicationWriter",
      ]);

      const fixture = await createTaxonomyFixture([W1]);
      try {
        for (const factory of ["openContextReader", "openEvidenceReader"]) {
          const open = api[factory] as (root: string) => Promise<Record<string, unknown>>;
          const bundle = await open(fixture.datasetRoot);
          const facade = bundle.context as Record<string, unknown>;
          requireCursorApi(facade, ["getReadCursor"]);
          // Readers get the read only; a writer method here would be a
          // capability the reader bundle must not carry.
          expect(typeof facade.advanceReadCursor).toBe("undefined");
          expect(typeof (facade as { close?: unknown }).close).toBe("undefined");
        }
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("prior state and expected precedence", () => {
  test(
    "absent, null-pointer and pointer rows are three distinct prior states",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n }, { publicId: MSG_B, seq: 2n }]);
      try {
        const reads = await reader(fixture);
        requireCursorApi(reads, ["getReadCursor"]);
        // Nothing seeded: get returns null, not an error (§6).
        expect(await (reads.getReadCursor as (b: Uint8Array) => Promise<unknown>)(
          encodeRequest(getRequest(W1)),
        )).toBeNull();

        // ABSENT + expected null -> created.
        const [created] = await runCursor(
          fixture,
          [{ method: "advanceReadCursor", request: advanceRequest(W1, { last_read_message_id: MSG_A }) }],
          { mode: "fixed", ms: Number(LATER_MS) },
        );
        expect(okResult(created!)).toEqual({
          outcome: "created",
          row: expectedRow(MSG_A, LATER_ISO),
        } as never);
        expect(Object.keys(okResult(created!).row as Record<string, unknown>)).toEqual([
          ...READ_CURSOR_FIELDS,
        ]);
        // And what actually landed on disk, independently authored, with the
        // timestamp compared as RAW microseconds rather than rendered text.
        expect(await storedRows(fixture, "read_cursors", scopeW1)).toEqual([
          expectedStoredRow(MSG_A, LATER_MS * MICROS_PER_MS),
        ] as never);

        // PRESENT-with-pointer + expected null (the ABSENT guard) -> conflict,
        // carrying the retained row so a caller can see what it actually is.
        const [mismatch] = await runCursor(
          fixture,
          [{ method: "advanceReadCursor", request: advanceRequest(W1, { last_read_message_id: MSG_B, expected: null }) }],
          { mode: "throw" },
        );
        expect(okResult(mismatch!)).toEqual({
          outcome: "conflict",
          reason: "expected",
          row: expectedRow(MSG_A, LATER_ISO),
        } as never);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "expected null-pointer against an absent row conflicts with row null",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n }]);
      try {
        const [action] = await runCursor(
          fixture,
          [{
            method: "advanceReadCursor",
            request: advanceRequest(W1, {
              last_read_message_id: MSG_A,
              expected: expectedPointer(null),
            }),
          }],
          { mode: "throw" },
        );
        // §2: row null occurs ONLY for an expected mismatch against absence.
        expect(okResult(action!)).toEqual({
          outcome: "conflict",
          reason: "expected",
          row: null,
        } as never);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a retained null-pointer row is readable and advanceable",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n }], {
        // This slice never creates a null-pointer row itself (§2); it is seeded
        // raw precisely because only retained history produces one.
        cursors: [{ pointer: null }],
      });
      try {
        const reads = await reader(fixture);
        requireCursorApi(reads, ["getReadCursor"]);
        expect(await (reads.getReadCursor as (b: Uint8Array) => Promise<unknown>)(
          encodeRequest(getRequest(W1)),
        )).toEqual(expectedRow(null, SEED_ISO) as never);

        const [advanced] = await runCursor(
          fixture,
          [{
            method: "advanceReadCursor",
            request: advanceRequest(W1, {
              last_read_message_id: MSG_A,
              expected: expectedPointer(null),
            }),
          }],
          { mode: "fixed", ms: Number(LATER_MS) },
        );
        // Exercises the composed IS NULL guard plus the TIMESTAMP(6)
        // assignment and readback, which §5 requires as one real statement
        // rather than two separately-evidenced primitives.
        expect(okResult(advanced!)).toEqual({
          outcome: "advanced",
          row: expectedRow(MSG_A, LATER_ISO),
        } as never);
        // The composed IS NULL guard plus TIMESTAMP(6) assignment is only
        // proved by what it left behind.
        expect(await storedRows(fixture, "read_cursors", scopeW1)).toEqual([
          expectedStoredRow(MSG_A, LATER_MS * MICROS_PER_MS),
        ] as never);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "already-current wins before expected comparison and samples no clock",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n }, { publicId: MSG_B, seq: 2n }], {
        cursors: [{ pointer: MSG_A }],
      });
      try {
        const [replay] = await runCursor(
          fixture,
          [{
            method: "advanceReadCursor",
            request: advanceRequest(W1, {
              last_read_message_id: MSG_A,
              // A deliberately STALE guard. §4 rule 1 decides already_satisfied
              // before any expected comparison, so this must not conflict.
              expected: expectedPointer(MSG_B),
            }),
          }],
          // A throwing clock turns "no sample" into a failure mode.
          { mode: "throw" },
        );
        expect(okResult(replay!)).toEqual({
          outcome: "already_satisfied",
          row: expectedRow(MSG_A, SEED_ISO),
        } as never);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("signed Int64 ordering", () => {
  const ordering: [string, bigint, bigint][] = [
    ["negative retained positions", -5n, -3n],
    ["nine to ten, where lexical order disagrees", 9n, 10n],
    ["beyond 2^53, where double comparison cannot separate the values", 9007199254740992n, 9007199254740993n],
    ["the Int64 ceiling", 9223372036854775806n, 9223372036854775807n],
  ];

  for (const [label, lower, higher] of ordering) {
    test(
      `advances across ${label}`,
      async () => {
        const fixture = await corpus(
          [{ publicId: MSG_A, seq: lower }, { publicId: MSG_B, seq: higher }],
          { cursors: [{ pointer: MSG_A }] },
        );
        try {
          const [advanced] = await runCursor(
            fixture,
            [{
              method: "advanceReadCursor",
              request: advanceRequest(W1, {
                last_read_message_id: MSG_B,
                expected: expectedPointer(MSG_A),
              }),
            }],
            { mode: "fixed", ms: Number(LATER_MS) },
          );
          // Asserts what MUST happen — the cursor advances and the complete
          // five-field row matches — rather than predicting which wrong answer
          // a particular defective comparison would give instead.
          expect(okResult(advanced!)).toEqual({
            outcome: "advanced",
            row: expectedRow(MSG_B, LATER_ISO),
          } as never);
          // Exact signed ordering is a storage claim too: the persisted row
          // must carry the higher pointer, not merely be reported as doing so.
          expect(await storedRows(fixture, "read_cursors", scopeW1)).toEqual([
            expectedStoredRow(MSG_B, LATER_MS * MICROS_PER_MS),
          ] as never);
        } finally {
          await fixture.cleanup();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  test(
    "a lower desired sequence is a non-mutating backward conflict, clock untouched",
    async () => {
      // Gaps are ORDINARY: retained rows and allocation history produce them.
      const fixture = await corpus(
        [{ publicId: MSG_A, seq: 1n }, { publicId: MSG_B, seq: 5n }, { publicId: MSG_C, seq: 9n }],
        { cursors: [{ pointer: MSG_B }] },
      );
      try {
        const before = snapshotOf(await runPlan(fixture, [{ op: "snapshot", tables: ["read_cursors"] }]));
        const [backward] = await runCursor(
          fixture,
          [{
            method: "advanceReadCursor",
            request: advanceRequest(W1, {
              last_read_message_id: MSG_A,
              expected: expectedPointer(MSG_B),
            }),
          }],
          { mode: "throw" },
        );
        expect(okResult(backward!)).toEqual({
          outcome: "conflict",
          reason: "backward",
          row: expectedRow(MSG_B, SEED_ISO),
        } as never);
        const after = snapshotOf(await runPlan(fixture, [{ op: "snapshot", tables: ["read_cursors"] }]));
        // Row count AND table version: a version bump at an equal count still
        // means something was written.
        expect(after).toEqual(before as never);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("namespace: request grammar versus retained corruption", () => {
  test(
    "a legacy numeric id in the REQUEST fails governed grammar before resolution",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n, id: 42n }]);
      try {
        const [action] = await runCursor(
          fixture,
          [{ method: "advanceReadCursor", request: advanceRequest(W1, { last_read_message_id: "42" }) }],
          { mode: "throw" },
        );
        const { name, error } = failure(action!);
        // §3: this never reaches reference resolution. It is a governed
        // ContractError on shape, NOT invalid_reference — asserting the latter
        // would assert the wrong layer entirely. The message is deterministic
        // at this accepted call site, so it is asserted exactly.
        expect(name).toBe("ContractError");
        expect(error).toEqual({
          version: "arra-error/v1",
          code: "invalid_value",
          path: "/last_read_message_id",
          message: NANOID_MESSAGE,
        });
        // The message row genuinely carries legacy id 42, so a dual-lookup
        // implementation would have had something to find.
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a RETAINED non-nanoid pointer is stored corruption, not a legacy lookup",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n, id: 42n }], {
        // ENGINE-ADMITTED: the store accepted this utf8 value, so the kernel
        // must reject it on read. There is no second namespace to fall back to.
        cursors: [{ pointer: "42" }],
      });
      try {
        const reads = await reader(fixture);
        requireCursorApi(reads, ["getReadCursor"]);
        expectThrownPublication(
          await rejection(
            (reads.getReadCursor as (b: Uint8Array) => Promise<unknown>)(encodeRequest(getRequest(W1))),
          ),
          "integrity_failure",
          "",
        );
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a retained pointer to a missing or wrong-session message is integrity, not absence",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n, session: OTHER_SESSION }], {
        sessions: [
          { workspace: W1, session: SESSION },
          { workspace: W1, session: OTHER_SESSION },
        ],
        cursors: [{ pointer: MSG_A }],
      });
      try {
        const reads = await reader(fixture);
        requireCursorApi(reads, ["getReadCursor"]);
        expectThrownPublication(
          await rejection(
            (reads.getReadCursor as (b: Uint8Array) => Promise<unknown>)(encodeRequest(getRequest(W1))),
          ),
          "integrity_failure",
          "",
        );
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a desired message in another session or workspace is an invalid reference",
    async () => {
      const fixture = await corpus(
        [
          { publicId: MSG_A, seq: 1n },
          { publicId: MSG_B, seq: 1n, session: OTHER_SESSION },
          { publicId: MSG_C, seq: 1n, workspace: W2 },
        ],
        {
          sessions: [
            { workspace: W1, session: SESSION },
            { workspace: W1, session: OTHER_SESSION },
            { workspace: W2, session: SESSION },
          ],
        },
      );
      try {
        const actions = await runCursor(
          fixture,
          [
            { method: "advanceReadCursor", request: advanceRequest(W1, { last_read_message_id: MSG_B }) },
            { method: "advanceReadCursor", request: advanceRequest(W1, { last_read_message_id: MSG_C }) },
          ],
          { mode: "throw" },
        );
        for (const action of actions) {
          expectPublicationError(action, "invalid_reference", "/last_read_message_id");
        }
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("selected duplicate identities", () => {
  test(
    "a duplicate cursor logical key is integrity failure on read AND on write",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n }, { publicId: MSG_B, seq: 2n }], {
        cursors: [{ pointer: MSG_A }, { pointer: MSG_A }],
      });
      try {
        const reads = await reader(fixture);
        requireCursorApi(reads, ["getReadCursor"]);
        expectThrownPublication(
          await rejection(
            (reads.getReadCursor as (b: Uint8Array) => Promise<unknown>)(encodeRequest(getRequest(W1))),
          ),
          "integrity_failure",
          "",
        );
        const [write] = await runCursor(
          fixture,
          [{ method: "advanceReadCursor", request: advanceRequest(W1, { last_read_message_id: MSG_B, expected: expectedPointer(MSG_A) }) }],
          { mode: "throw" },
        );
        // Never "pick one" and never repair.
        expectPublicationError(write!, "integrity_failure", "");
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a duplicate public_id or duplicate selected sequence is integrity failure",
    async () => {
      const duplicatePublicId = await corpus([
        { publicId: MSG_A, seq: 1n },
        { publicId: MSG_A, seq: 2n, id: 99n },
      ]);
      try {
        const [action] = await runCursor(
          duplicatePublicId,
          [{ method: "advanceReadCursor", request: advanceRequest(W1, { last_read_message_id: MSG_A }) }],
          { mode: "throw" },
        );
        expectPublicationError(action!, "integrity_failure", "");
      } finally {
        await duplicatePublicId.cleanup();
      }

      const duplicateSeq = await corpus([
        { publicId: MSG_A, seq: 7n },
        { publicId: MSG_B, seq: 7n, id: 98n },
      ]);
      try {
        const [action] = await runCursor(
          duplicateSeq,
          [{ method: "advanceReadCursor", request: advanceRequest(W1, { last_read_message_id: MSG_A }) }],
          { mode: "throw" },
        );
        // §3 requires the (W, session, seq) equality lookup to select exactly
        // ONE same row. Equal seq with different ids is rejected here, never
        // classified as already_satisfied.
        expectPublicationError(action!, "integrity_failure", "");
      } finally {
        await duplicateSeq.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("timestamps and clock", () => {
  test(
    "a sub-millisecond retained timestamp fails closed rather than rounding",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n }], {
        // ENGINE-ADMITTED corruption: raw Arrow stored a microsecond remainder,
        // so the store accepted it and the kernel must refuse it on read.
        // Whether the engine would admit a NULL here is a separate question
        // this file does not test and does not infer from the NOT NULL
        // declaration; pure-encoder rejection of malformed input is core's.
        cursors: [{ pointer: MSG_A, micros: SEED_MICROS + 1n }],
      });
      try {
        const reads = await reader(fixture);
        requireCursorApi(reads, ["getReadCursor"]);
        expectThrownPublication(
          await rejection(
            (reads.getReadCursor as (b: Uint8Array) => Promise<unknown>)(encodeRequest(getRequest(W1))),
          ),
          "integrity_failure",
          "",
        );
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the Gregorian endpoints render exactly, and an out-of-range value never renders",
    async () => {
      // §3 requires the retained raw microseconds to be divisible by 1000 AND
      // within Gregorian 0001..9999 before rendering. The endpoints are the
      // cases where an off-by-one bound or a Date-range extension shows up.
      const MIN_MS = -62135596800000n; // 0001-01-01T00:00:00.000Z
      const MAX_MS = 253402300799999n; // 9999-12-31T23:59:59.999Z
      const MIN_ISO = new Date(Number(MIN_MS)).toISOString();
      const MAX_ISO = new Date(Number(MAX_MS)).toISOString();
      expect(MIN_ISO).toBe("0001-01-01T00:00:00.000Z");
      expect(MAX_ISO).toBe("9999-12-31T23:59:59.999Z");

      for (const [label, ms, iso] of [
        ["lower", MIN_MS, MIN_ISO],
        ["upper", MAX_MS, MAX_ISO],
      ] as [string, bigint, string][]) {
        const fixture = await corpus([{ publicId: MSG_A, seq: 1n }], {
          cursors: [{ pointer: MSG_A, micros: ms * MICROS_PER_MS }],
        });
        try {
          const reads = await reader(fixture);
          requireCursorApi(reads, ["getReadCursor"]);
          const row = await (reads.getReadCursor as (b: Uint8Array) => Promise<unknown>)(
            encodeRequest(getRequest(W1)),
          );
          // Valid endpoint: served, rendered exactly, no clamping.
          expect(row).toEqual(expectedRow(MSG_A, iso) as never);
          expect(label.length).toBeGreaterThan(0);
        } finally {
          await fixture.cleanup();
        }
      }

      // BOTH sides of the range, one millisecond outside each bound. Whether
      // the ENGINE admits such a value is MEASURED through the narrow probe,
      // never inferred from a failed command: a broad catch here would let a
      // child launch fault, a gate error or a timeout masquerade as store
      // enforcement. Pure-encoder refusal of malformed input, independent of
      // any engine, is core's proof and not this file's.
      for (const [bound, micros] of [
        ["upper-plus-one", (MAX_MS + 1n) * MICROS_PER_MS],
        ["lower-minus-one", (MIN_MS - 1n) * MICROS_PER_MS],
      ] as [string, bigint][]) {
        const fixture = await corpus([{ publicId: MSG_A, seq: 1n }]);
        try {
          const admission = await probeAdmission(fixture, "read_cursors", [
            cursorRow({ pointer: MSG_A, micros }),
          ]);

          const reads = await reader(fixture);
          requireCursorApi(reads, ["getReadCursor"]);
          if (admission.admitted) {
            // Engine-admitted corruption: the kernel must refuse to serve it
            // rather than render a timestamp outside the supported range.
            expectThrownPublication(
              await rejection(
                (reads.getReadCursor as (b: Uint8Array) => Promise<unknown>)(
                  encodeRequest(getRequest(W1)),
                ),
              ),
              "integrity_failure",
              "",
            );
          } else {
            // The STORE refused it. Record what it actually said rather than a
            // bare boolean, and assert the only thing that holds either way:
            // nothing partial landed. No kernel behaviour is claimed for a
            // value the kernel was never given.
            expect(admission.refusal.message.length).toBeGreaterThan(0);
            expect(await storedRows(fixture, "read_cursors", scopeW1)).toEqual([] as never);
          }
          expect(bound.length).toBeGreaterThan(0);
        } finally {
          await fixture.cleanup();
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a regressed clock writes nothing, and the table version proves it",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n }, { publicId: MSG_B, seq: 2n }], {
        cursors: [{ pointer: MSG_A, micros: LATER_MS * MICROS_PER_MS }],
      });
      try {
        const before = snapshotOf(await runPlan(fixture, [{ op: "snapshot", tables: ["read_cursors"] }]));
        const [action] = await runCursor(
          fixture,
          [{ method: "advanceReadCursor", request: advanceRequest(W1, { last_read_message_id: MSG_B, expected: expectedPointer(MSG_A) }) }],
          // Behind the retained timestamp by a minute.
          { mode: "fixed", ms: Number(SEED_MS) },
        );
        // §4 rule 4: root path, and the clock is operator configuration rather
        // than a blamed caller field, so the pointer is empty.
        expectPublicationError(action!, "invalid_request", "");
        const after = snapshotOf(await runPlan(fixture, [{ op: "snapshot", tables: ["read_cursors"] }]));
        expect(after).toEqual(before as never);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a clock exactly equal to the retained timestamp is permitted",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n }, { publicId: MSG_B, seq: 2n }], {
        cursors: [{ pointer: MSG_A, micros: SEED_MICROS }],
      });
      try {
        const [action] = await runCursor(
          fixture,
          [{ method: "advanceReadCursor", request: advanceRequest(W1, { last_read_message_id: MSG_B, expected: expectedPointer(MSG_A) }) }],
          // BigInt(clockMs) * 1000n === retained micros exactly. §4 allows
          // equality, and comparing milliseconds against microseconds directly
          // is the mistake this case is shaped to catch.
          { mode: "fixed", ms: Number(SEED_MS) },
        );
        expect(okResult(action!)).toEqual({
          outcome: "advanced",
          row: expectedRow(MSG_B, SEED_ISO),
        } as never);
        expect(await storedRows(fixture, "read_cursors", scopeW1)).toEqual([
          expectedStoredRow(MSG_B, SEED_MICROS),
        ] as never);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("retired history", () => {
  test(
    "an inactive session and a departed membership still read and advance, with no policy mutation",
    async () => {
      const fixture = await corpus([{ publicId: MSG_A, seq: 1n }, { publicId: MSG_B, seq: 2n }], {
        sessions: [{ workspace: W1, session: SESSION, active: false, left: true }],
        cursors: [{ pointer: MSG_A }],
      });
      try {
        const reads = await reader(fixture);
        requireCursorApi(reads, ["getReadCursor"]);

        // The setup is asserted, not assumed: a test that never checks the
        // session is actually inactive proves nothing about retirement.
        const sessionsBefore = await storedRows(fixture, "sessions", scopeW1);
        const membershipBefore = await storedRows(fixture, "session_peers", scopeW1);
        expect(sessionsBefore).toHaveLength(1);
        expect(sessionsBefore[0]!.is_active).toBe(false);
        expect(membershipBefore).toHaveLength(1);
        expect(membershipBefore[0]!.left_at).not.toBeNull();
        const beforeSnapshot = snapshotOf(
          await runPlan(fixture, [{ op: "snapshot", tables: ["sessions", "session_peers"] }]),
        ) as Record<string, { version: number; rows: number }>;
        const sessionsVersionBefore = beforeSnapshot.sessions!.version;
        const membershipVersionBefore = beforeSnapshot.session_peers!.version;

        // §3: retirement and departure do not forbid reading or recording
        // progress, and this policy deliberately differs from appendMessages.
        expect(await (reads.getReadCursor as (b: Uint8Array) => Promise<unknown>)(
          encodeRequest(getRequest(W1)),
        )).toEqual(expectedRow(MSG_A, SEED_ISO) as never);

        const [advanced] = await runCursor(
          fixture,
          [{ method: "advanceReadCursor", request: advanceRequest(W1, { last_read_message_id: MSG_B, expected: expectedPointer(MSG_A) }) }],
          { mode: "fixed", ms: Number(LATER_MS) },
        );
        expect(okResult(advanced!)).toEqual({
          outcome: "advanced",
          row: expectedRow(MSG_B, LATER_ISO),
        } as never);

        expect(await storedRows(fixture, "read_cursors", scopeW1)).toEqual([
          expectedStoredRow(MSG_B, LATER_MS * MICROS_PER_MS),
        ] as never);

        // No rejoin and no reactivation. Counting rows would pass a
        // reactivation that flipped is_active or cleared left_at in place, so
        // the whole rows are compared field by field, and the table versions
        // alongside them: an in-place update keeps the count and moves the
        // version.
        const afterSnapshot = snapshotOf(
          await runPlan(fixture, [{ op: "snapshot", tables: ["sessions", "session_peers"] }]),
        ) as Record<string, { version: number; rows: number }>;
        expect(await storedRows(fixture, "sessions", scopeW1)).toEqual(sessionsBefore as never);
        expect(await storedRows(fixture, "session_peers", scopeW1)).toEqual(membershipBefore as never);
        expect(afterSnapshot.sessions!.version).toBe(sessionsVersionBefore);
        expect(afterSnapshot.session_peers!.version).toBe(membershipVersionBefore);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
