/**
 * #28 precision and order evidence (contract §9, PRECISION/ORDER lane).
 *
 * Scope, and nothing wider: ordered allocation across negative, beyond-2^53 and
 * Int64-ceiling keys; exact timestamp and Int64 wire values with sub-millisecond
 * refusal; keyset pagination against distractors and gaps; duplicate detection
 * at the SELECTED extremum with no whole-corpus claim; the 1024/1025 reply
 * ancestry bound; and the 16 MiB response budget at exactly the limit and one
 * byte over.
 *
 * ABSENT API IS NOT GREEN EVIDENCE. At the base commit `openContextWriter` and
 * `openContextReader` do not exist. Every test therefore calls
 * `requireContextApi()` FIRST — before any fixture is built or any child is
 * spawned — so the suite fails loudly with a legible reason instead of either
 * skipping (which would be green from nothing) or spending a minute of process
 * work to reach an undefined call. These tests are red by construction until
 * core lands, and that red is the honest state, not a defect in this file.
 *
 * Expectations are authored here. `expectedRowBytes` and the 2-plus-rows-plus-
 * commas accounting below are an independent restatement of contract §6, not an
 * import of any product encoder: if the service counted the budget differently
 * these tests would fail rather than agree with it.
 *
 * Bounded claims. Seeding writes legacy-shaped extremes and duplicate keys that
 * no service path would ever allocate, so the dataset is disposable fixture
 * state, never a live one. Selected-extremum duplicate detection is asserted as
 * exactly that: §4 says non-extremal untouched duplicates are NOT claimed
 * detected, and one test below pins that limit deliberately rather than
 * pretending allocation audits the corpus. The wire budget bounds the RESPONSE,
 * not SDK engine work or peak memory.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as service from "../../../src/publication/service";
import { CHILD_DEADLINE_MS, runGated } from "../../helpers/publication-fixture";
import { createTaxonomyFixture, type TaxonomyFixture } from "../../helpers/taxonomy-fixture";

const CHILD = new URL("./precision/seed-child.ts", import.meta.url).pathname;
const SEED_DEADLINE_MS = 300_000;
const TEST_TIMEOUT_MS = 600_000;

/** Contract §6 and §4, restated here rather than imported. */
const RESPONSE_BUDGET_BYTES = 16 * 1024 * 1024;
const REPLY_VISIT_LIMIT = 1024;
const INT64_MAX = 2n ** 63n - 1n;
const BEYOND_DOUBLE = 2n ** 53n + 1n;

/** The 20 physical Message columns, transcribed from target_v1/core.py. */
const MESSAGE_WIRE_ORDER = [
  "id", "public_id", "workspace_name", "session_name", "peer_name", "content",
  "token_count", "seq_in_session", "h_metadata", "internal_metadata", "created_at",
  "role", "in_reply_to", "read", "read_at",
  "source_namespace", "source_message_id", "source_payload_digest", "source_created_at",
  "ingested_at",
] as const;

const WORKSPACE = "alpha-workspace";
const OTHER_WORKSPACE = "beta-workspace";
const SESSION = "s-main";
const OTHER_SESSION = "s-other";
const PEER = "p-author";

const MICROS_PER_MS = 1000n;
const SEED_MS = 1789948800000n; // 2026-09-21T00:00:00.000Z
const SEED_MICROS = SEED_MS * MICROS_PER_MS;

const utf8 = (text: string): number => new TextEncoder().encode(text).byteLength;

/**
 * The context API this lane tests does not exist yet.
 *
 * Called at the top of every test, before any fixture or child, so an absent
 * API costs one assertion rather than a minute of setup — and so the failure
 * names the missing export instead of surfacing as `undefined is not a
 * function` several frames deep.
 */
function requireContextApi(): {
  openContextWriter: (root: string, options: Record<string, unknown>) => Promise<never>;
  openContextReader: (root: string) => Promise<never>;
} {
  const api = service as unknown as Record<string, unknown>;
  const missing = ["openContextWriter", "openContextReader"].filter(
    (name) => typeof api[name] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `context API absent: ${missing.join(", ")} not exported from publication/service. ` +
        "Expected from #59; these precision tests are red by construction until it lands.",
    );
  }
  return api as never;
}

// ── independent wire oracle ─────────────────────────────────────────────────

/** Exact UTC millisecond string, or null. Refuses a sub-millisecond remainder. */
function millisecondText(micros: bigint | null): string | null {
  if (micros === null) return null;
  if (micros % MICROS_PER_MS !== 0n) {
    throw new Error("expected wire value has sub-millisecond precision");
  }
  return new Date(Number(micros / MICROS_PER_MS)).toISOString();
}

type SeedMessage = {
  id: bigint;
  public_id: string;
  workspace_name?: string;
  session_name?: string;
  peer_name?: string;
  content?: string;
  contentPad?: number;
  token_count?: bigint;
  seq: bigint;
  created_at?: bigint;
  ingested_at?: bigint;
  in_reply_to?: string | null;
  role?: string | null;
};

/** What this file says the service must return for a seeded row. */
function expectedRow(seed: SeedMessage): Record<string, unknown> {
  const content = `${seed.content ?? "c"}${"a".repeat(seed.contentPad ?? 0)}`;
  return {
    id: seed.id.toString(10),
    public_id: seed.public_id,
    workspace_name: seed.workspace_name ?? WORKSPACE,
    session_name: seed.session_name ?? SESSION,
    peer_name: seed.peer_name ?? PEER,
    content,
    token_count: (seed.token_count ?? 0n).toString(10),
    seq_in_session: seed.seq.toString(10),
    h_metadata: null,
    internal_metadata: null,
    created_at: millisecondText(seed.created_at ?? SEED_MICROS),
    role: seed.role ?? null,
    in_reply_to: seed.in_reply_to ?? null,
    read: null,
    read_at: null,
    source_namespace: null,
    source_message_id: null,
    source_payload_digest: null,
    source_created_at: null,
    ingested_at: millisecondText(seed.ingested_at ?? SEED_MICROS),
  };
}

/** One row's compact JSON byte length, fields in physical order. */
function expectedRowBytes(row: Record<string, unknown>): number {
  const ordered: Record<string, unknown> = {};
  for (const field of MESSAGE_WIRE_ORDER) ordered[field] = row[field] ?? null;
  return utf8(JSON.stringify(ordered));
}

/** §6: the ARRAY only — two brackets, each row, one comma between rows. */
function expectedArrayBytes(rows: Record<string, unknown>[]): number {
  let total = 2;
  for (let i = 0; i < rows.length; i++) total += expectedRowBytes(rows[i]!) + (i > 0 ? 1 : 0);
  return total;
}

// ── seeding ─────────────────────────────────────────────────────────────────

function id21(prefix: string, n: number): string {
  const digits = String(n).padStart(6, "0");
  return `${prefix}${"_".repeat(Math.max(0, 21 - prefix.length - digits.length))}${digits}`.slice(0, 21);
}

/** Plan row: raw micros as decimal TEXT so sub-millisecond values are sayable. */
function seedRow(seed: SeedMessage): Record<string, unknown> {
  return {
    id: seed.id.toString(10),
    public_id: seed.public_id,
    workspace_name: seed.workspace_name ?? WORKSPACE,
    session_name: seed.session_name ?? SESSION,
    peer_name: seed.peer_name ?? PEER,
    content: seed.content ?? "c",
    content_pad: seed.contentPad ?? 0,
    token_count: (seed.token_count ?? 0n).toString(10),
    seq_in_session: seed.seq.toString(10),
    created_at: (seed.created_at ?? SEED_MICROS).toString(10),
    ingested_at: (seed.ingested_at ?? SEED_MICROS).toString(10),
    in_reply_to: seed.in_reply_to ?? null,
    role: seed.role ?? null,
  };
}

function registrationSteps(sessions: { workspace: string; session: string }[]): unknown[] {
  const peers = sessions.map(({ workspace }) => workspace);
  const unique = [...new Set(peers)];
  return [
    {
      op: "seed",
      table: "peers",
      rows: unique.map((workspace) => ({
        id: id21("peer", unique.indexOf(workspace) + 1),
        name: PEER,
        workspace_name: workspace,
        created_at: SEED_MICROS.toString(10),
      })),
    },
    {
      op: "seed",
      table: "sessions",
      rows: sessions.map(({ workspace, session }, index) => ({
        id: id21("sess", index + 1),
        name: session,
        workspace_name: workspace,
        is_active: true,
        created_at: SEED_MICROS.toString(10),
      })),
    },
    {
      op: "seed",
      table: "session_peers",
      rows: sessions.map(({ workspace, session }) => ({
        workspace_name: workspace,
        session_name: session,
        peer_name: PEER,
        joined_at: SEED_MICROS.toString(10),
        left_at: null,
      })),
    },
  ];
}

/** Run the owned gated child once. The frozen helper owns the deadline. */
async function runPlan(fixture: TaxonomyFixture, steps: unknown[]): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), "arra-ctx28-plan-"));
  const planPath = join(dir, "plan.json");
  try {
    await writeFile(planPath, JSON.stringify({ datasetRoot: fixture.datasetRoot, steps }), "utf8");
    const run = await runGated(fixture.datasetRoot, CHILD, [planPath], {
      deadlineMs: Math.min(SEED_DEADLINE_MS, Math.max(CHILD_DEADLINE_MS, SEED_DEADLINE_MS)),
    });
    if (run.code !== 0) {
      throw new Error(`gated seed child failed (${run.code}): ${run.stderr.slice(0, 1200)}`);
    }
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const encodeRequest = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

/** Assert all four envelope fields. Code alone is what hid the #47 defect. */
function expectEnvelope(
  error: unknown,
  expected: { name: string; version: string; code: string; path: string },
): void {
  const shaped = error as { name?: string; code?: string; toJSON?: () => Record<string, unknown> };
  expect(shaped.name).toBe(expected.name);
  const envelope = shaped.toJSON?.() ?? {};
  expect(envelope.version).toBe(expected.version);
  expect(envelope.code).toBe(expected.code);
  expect(envelope.path).toBe(expected.path);
}

/**
 * The fixed safe messages, restated rather than imported.
 *
 * One per code, never interpolated. Written out here so a change to the
 * product's message table fails this file instead of being adopted by it.
 */
const SAFE_MESSAGE = {
  integrity_failure: "stored state failed integrity validation",
  limit_exceeded: "publication limit exceeded",
} as const;

type ChildAction =
  | { method: string; ok: true; result: Record<string, unknown> }
  | { method: string; ok: false; name: string | null; error: Record<string, unknown> };

/**
 * Run writer operations INSIDE the gated child.
 *
 * The parent cannot hold the gate: the bare fixture exporter takes it, finishes
 * and releases it, so a parent-side `openContextWriter` fails
 * `writer_unavailable` before reaching anything under test. Readers need no
 * gate and stay in the parent, which is also what keeps the read assertions
 * independent of the process that did the writing.
 */
async function runContext(
  fixture: TaxonomyFixture,
  actions: { method: string; request: unknown }[],
  sourceNamespace: string | null = null,
): Promise<ChildAction[]> {
  const output = await runPlan(fixture, [{ op: "context", sourceNamespace, actions }]);
  const entry = (output.results as Record<string, unknown>[]).find((row) => row.op === "context");
  if (entry === undefined) throw new Error("child produced no context result");
  return entry.actions as ChildAction[];
}

/**
 * An item rejected AFTER queue admission is a stopped RESULT, not a throw.
 *
 * `stop.error` is the exact `toJSON()` envelope — version, code, path, message
 * — and carries no `name`, so asserting a name here would be asserting
 * something the wire never had. Comparing the whole `stop` object also proves
 * the union stayed closed: a variant carrying both `error` and `conflict` would
 * fail this equality rather than slip past a field-by-field check.
 */
function expectStop(
  result: Record<string, unknown>,
  expected: { index: number; code: keyof typeof SAFE_MESSAGE; path: string },
): void {
  expect(result.outcome).toBe("stopped");
  expect(result.results).toEqual([]);
  expect(result.stop).toEqual({
    index: expected.index,
    error: {
      version: "arra-publication-error/v1",
      code: expected.code,
      path: expected.path,
      message: SAFE_MESSAGE[expected.code],
    },
  });
}

function appendRequest(items: Record<string, unknown>[], session = SESSION) {
  return { workspace_name: WORKSPACE, session_name: session, items };
}

function localItem(publicId: string, overrides: Record<string, unknown> = {}) {
  return {
    public_id: publicId,
    message: { peer_name: PEER, role: null, content: "c", in_reply_to: null, ...overrides },
    source: null,
  };
}

function okResult(action: ChildAction): Record<string, unknown> {
  if (!action.ok) {
    throw new Error(`expected a value, child threw ${JSON.stringify(action.error)}`);
  }
  return action.result;
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

// ── tests ───────────────────────────────────────────────────────────────────

describe("context surface", () => {
  test("service exports exactly the nine runtime names", () => {
    requireContextApi();
    const exported = Object.keys(service).sort();
    expect(exported).toEqual([
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
  });
});

describe("ordered allocation across Int64 extremes", () => {
  test(
    "next id and sequence follow the stored maxima, not row order or JS Number",
    async () => {
      requireContextApi();
      const fixture = await createTaxonomyFixture([WORKSPACE, OTHER_WORKSPACE]);
      try {
        // Retained legacy values: a negative id, one beyond 2^53 where Number
        // comparison starts losing, and rows seeded in an order that does NOT
        // put the maximum last.
        const seeds: SeedMessage[] = [
          { id: BEYOND_DOUBLE, public_id: id21("m", 2), seq: 7n },
          { id: -5n, public_id: id21("m", 1), seq: -3n },
          { id: BEYOND_DOUBLE - 2n, public_id: id21("m", 3), seq: 2n },
        ];
        await runPlan(fixture, [
          ...registrationSteps([{ workspace: WORKSPACE, session: SESSION }]),
          { op: "seed", table: "messages", rows: seeds.map(seedRow) },
        ]);

        const [append] = await runContext(fixture, [
          { method: "appendMessages", request: appendRequest([localItem(id21("new", 1))]) },
        ]);
        const result = okResult(append!) as {
          outcome: string;
          results: { index: number; outcome: string; row: Record<string, unknown> }[];
          stop: unknown;
        };

        expect(result.outcome).toBe("complete");
        expect(result.stop).toBeNull();
        const row = result.results[0]!.row;
        // max(id) is 2^53+1, so the next id is 2^53+2 — a value a Number-based
        // maximum would have rounded into a collision.
        expect(row.id).toBe((BEYOND_DOUBLE + 1n).toString(10));
        // The session maximum is 7 even though a negative sequence is retained.
        expect(row.seq_in_session).toBe("8");
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an allocation that would exceed the Int64 ceiling stops before any write",
    async () => {
      requireContextApi();
      const fixture = await createTaxonomyFixture([WORKSPACE]);
      try {
        const seeded = await runPlan(fixture, [
          ...registrationSteps([{ workspace: WORKSPACE, session: SESSION }]),
          {
            op: "seed",
            table: "messages",
            rows: [seedRow({ id: INT64_MAX, public_id: id21("m", 1), seq: INT64_MAX })],
          },
          { op: "snapshot", tables: ["messages"] },
        ]);
        const before = (seeded.results as Record<string, unknown>[]).find(
          (entry) => entry.op === "snapshot",
        )!.snapshot;

        const [append] = await runContext(fixture, [
          { method: "appendMessages", request: appendRequest([localItem(id21("new", 1))]) },
        ]);
        // Overflow is stored-state/allocation, not request shape: integrity_failure
        // at the root path, returned as a stopped result after admission.
        expectStop(okResult(append!), { index: 0, code: "integrity_failure", path: "" });

        const settled = await runPlan(fixture, [{ op: "snapshot", tables: ["messages"] }]);
        const after = (settled.results as Record<string, unknown>[]).find(
          (entry) => entry.op === "snapshot",
        )!.snapshot;
        // Refused BEFORE any write: row count AND table version both unmoved. A
        // version bump with an equal row count would still mean something was
        // written and then not counted.
        expect(after).toEqual(before as never);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("exact wire values", () => {
  test(
    "a sub-millisecond stored timestamp fails closed rather than being normalised",
    async () => {
      const { openContextReader } = requireContextApi();
      const fixture = await createTaxonomyFixture([WORKSPACE]);
      try {
        const publicId = id21("sub", 1);
        await runPlan(fixture, [
          ...registrationSteps([{ workspace: WORKSPACE, session: SESSION }]),
          {
            op: "seed",
            table: "messages",
            rows: [
              seedRow({
                id: 1n,
                public_id: publicId,
                seq: 1n,
                // One microsecond past an exact millisecond. §6: legacy sub-ms
                // rows fail closed here; they are neither normalised nor deleted.
                created_at: SEED_MICROS + 1n,
              }),
            ],
          },
        ]);

        const reader = await openContextReader(fixture.datasetRoot);
        const error = await rejection(
          (reader as never as {
            context: { getMessage(bytes: Uint8Array): Promise<unknown> };
          }).context.getMessage(encodeRequest({ workspace_name: WORKSPACE, public_id: publicId })),
        );
        expectEnvelope(error, {
          name: "PublicationError",
          version: "arra-publication-error/v1",
          code: "integrity_failure",
          path: "",
        });
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "every physical column wires exactly, including negative and ceiling Int64",
    async () => {
      const { openContextReader } = requireContextApi();
      const fixture = await createTaxonomyFixture([WORKSPACE]);
      try {
        const seeds: SeedMessage[] = [
          { id: -9007199254740993n, public_id: id21("neg", 1), seq: -1n, token_count: 0n },
          { id: INT64_MAX, public_id: id21("max", 1), seq: BEYOND_DOUBLE, token_count: 5n },
        ];
        await runPlan(fixture, [
          ...registrationSteps([{ workspace: WORKSPACE, session: SESSION }]),
          { op: "seed", table: "messages", rows: seeds.map(seedRow) },
        ]);

        const reader = await openContextReader(fixture.datasetRoot);
        for (const seed of seeds) {
          const row = await (reader as never as {
            context: { getMessage(bytes: Uint8Array): Promise<Record<string, unknown>> };
          }).context.getMessage(
            encodeRequest({ workspace_name: WORKSPACE, public_id: seed.public_id }),
          );
          // Field-by-field equality against an expectation this file authored,
          // in the literal physical order, with Int64 as decimal TEXT.
          expect(Object.keys(row)).toEqual([...MESSAGE_WIRE_ORDER]);
          expect(row).toEqual(expectedRow(seed));
        }
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("keyset pagination", () => {
  test(
    "pages by seq with gaps, never leaking another session or workspace",
    async () => {
      const { openContextReader } = requireContextApi();
      const fixture = await createTaxonomyFixture([WORKSPACE, OTHER_WORKSPACE]);
      try {
        const wanted: SeedMessage[] = [-4n, 1n, 2n, 5n, 9n].map((seq, index) => ({
          id: BigInt(index + 1),
          public_id: id21("want", index + 1),
          seq,
        }));
        // Distractors carrying the SAME sequence numbers in another session and
        // another workspace. A predicate that forgot either scope would surface
        // them, and an offset pager would mis-page around the gaps.
        const distractors: SeedMessage[] = [-4n, 1n, 2n, 5n, 9n].flatMap((seq, index) => [
          {
            id: BigInt(100 + index),
            public_id: id21("dsess", index + 1),
            seq,
            session_name: OTHER_SESSION,
          },
          {
            id: BigInt(200 + index),
            public_id: id21("dws", index + 1),
            seq,
            workspace_name: OTHER_WORKSPACE,
            session_name: SESSION,
          },
        ]);

        await runPlan(fixture, [
          ...registrationSteps([
            { workspace: WORKSPACE, session: SESSION },
            { workspace: WORKSPACE, session: OTHER_SESSION },
            { workspace: OTHER_WORKSPACE, session: SESSION },
          ]),
          { op: "seed", table: "messages", rows: [...wanted, ...distractors].map(seedRow) },
        ]);

        const reader = await openContextReader(fixture.datasetRoot);
        const list = (bytes: Uint8Array) =>
          (reader as never as {
            context: {
              listMessages(b: Uint8Array): Promise<{
                rows: Record<string, unknown>[];
                next_after_seq: string | null;
              }>;
            };
          }).context.listMessages(bytes);

        const first = await list(
          encodeRequest({
            workspace_name: WORKSPACE,
            session_name: SESSION,
            after_seq: null,
            limit: 2,
          }),
        );
        // Ascending by exact Int64: the negative sequence sorts FIRST. A Number
        // sort or a string sort would not put -4 before 1.
        expect(first.rows.map((row) => row.seq_in_session)).toEqual(["-4", "1"]);
        expect(first.next_after_seq).toBe("1");

        const second = await list(
          encodeRequest({
            workspace_name: WORKSPACE,
            session_name: SESSION,
            after_seq: first.next_after_seq,
            limit: 2,
          }),
        );
        // Exclusive cursor, and the gap between 2 and 5 is crossed, never filled.
        expect(second.rows.map((row) => row.seq_in_session)).toEqual(["2", "5"]);
        expect(second.next_after_seq).toBe("5");

        const third = await list(
          encodeRequest({
            workspace_name: WORKSPACE,
            session_name: SESSION,
            after_seq: second.next_after_seq,
            limit: 2,
          }),
        );
        // Last page: fewer rows than the limit means no continuation cursor.
        expect(third.rows.map((row) => row.seq_in_session)).toEqual(["9"]);
        expect(third.next_after_seq).toBeNull();

        const beyond = await list(
          encodeRequest({
            workspace_name: WORKSPACE,
            session_name: SESSION,
            after_seq: "9",
            limit: 2,
          }),
        );
        expect(beyond).toEqual({ rows: [], next_after_seq: null });

        // Nothing from the other session or workspace ever appeared.
        const seen = [...first.rows, ...second.rows, ...third.rows];
        for (const row of seen) {
          expect(row.workspace_name).toBe(WORKSPACE);
          expect(row.session_name).toBe(SESSION);
        }
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("selected duplicate detection, and its stated limit", () => {
  test(
    "a duplicate at the SELECTED maximum stops on integrity before allocation",
    async () => {
      requireContextApi();
      const fixture = await createTaxonomyFixture([WORKSPACE]);
      try {
        await runPlan(fixture, [
          ...registrationSteps([{ workspace: WORKSPACE, session: SESSION }]),
          {
            op: "seed",
            table: "messages",
            rows: [
              seedRow({ id: 10n, public_id: id21("dup", 1), seq: 10n }),
              // Same session sequence as the row above, and it IS the maximum,
              // so the equality lookup validating the selected extremum sees
              // two rows on one allocation key.
              seedRow({ id: 11n, public_id: id21("dup", 2), seq: 10n }),
            ],
          },
        ]);

        const [append] = await runContext(fixture, [
          { method: "appendMessages", request: appendRequest([localItem(id21("new", 1))]) },
        ]);
        expectStop(okResult(append!), { index: 0, code: "integrity_failure", path: "" });
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a duplicate BELOW the maximum is not detected, and the contract says so",
    async () => {
      // This test pins a LIMIT, not a capability. §4: "This is NOT a whole-corpus
      // corruption audit: non-extremal untouched duplicate legacy keys are not
      // claimed detected by allocation." Asserting the append SUCCEEDS is how
      // that sentence stays true in code — if a later change made allocation
      // scan the corpus, this fails and the claim gets re-decided deliberately
      // instead of quietly widening into an overclaim.
      requireContextApi();
      const fixture = await createTaxonomyFixture([WORKSPACE]);
      try {
        await runPlan(fixture, [
          ...registrationSteps([{ workspace: WORKSPACE, session: SESSION }]),
          {
            op: "seed",
            table: "messages",
            rows: [
              seedRow({ id: 1n, public_id: id21("low", 1), seq: 3n }),
              seedRow({ id: 2n, public_id: id21("low", 2), seq: 3n }), // duplicate, not extremal
              seedRow({ id: 3n, public_id: id21("top", 1), seq: 9n }), // unique maximum
            ],
          },
        ]);

        const [append] = await runContext(fixture, [
          { method: "appendMessages", request: appendRequest([localItem(id21("new", 1))]) },
        ]);
        const result = okResult(append!) as {
          outcome: string;
          results: { row: Record<string, unknown> }[];
          stop: unknown;
        };
        expect(result.outcome).toBe("complete");
        expect(result.stop).toBeNull();
        expect(result.results[0]!.row.seq_in_session).toBe("10");
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("reply ancestry bound", () => {
  test(
    "1024 visited stored ancestors is accepted and 1025 stops on limit_exceeded",
    async () => {
      requireContextApi();
      const fixture = await createTaxonomyFixture([WORKSPACE]);
      try {
        // The bound counts STORED ancestors VISITED, not the hypothetical new
        // row. Replying to chain[k] walks chain[k] back to chain[1], which is
        // exactly k stored rows. So the discriminating pair is parent 1024
        // (accepted) against parent 1025 (refused), and the chain has to be
        // 1025 long for the second one to exist at all.
        const chainLength = REPLY_VISIT_LIMIT + 1;
        const chain: SeedMessage[] = [];
        for (let i = 1; i <= chainLength; i++) {
          chain.push({
            id: BigInt(i),
            public_id: id21("chain", i),
            seq: BigInt(i),
            in_reply_to: i === 1 ? null : id21("chain", i - 1),
          });
        }
        await runPlan(fixture, [
          ...registrationSteps([{ workspace: WORKSPACE, session: SESSION }]),
          { op: "seed", table: "messages", rows: chain.map(seedRow) },
        ]);

        // Both appends run against ONE writer in ONE gated child: a second
        // child would be a second gate acquisition, and close() releases the
        // inherited descriptor so a process cannot retake it anyway.
        const [accepted, refused] = await runContext(fixture, [
          {
            method: "appendMessages",
            request: appendRequest([
              localItem(id21("ok", 1), { in_reply_to: id21("chain", REPLY_VISIT_LIMIT) }),
            ]),
          },
          {
            method: "appendMessages",
            request: appendRequest([
              localItem(id21("no", 1), { in_reply_to: id21("chain", chainLength) }),
            ]),
          },
        ]);

        const first = okResult(accepted!) as {
          outcome: string;
          results: { row: Record<string, unknown> }[];
        };
        expect(first.outcome).toBe("complete");
        // Assert the accepted identity, not just the outcome: the row must be
        // the one that was asked for, linked where it was asked to link.
        expect(first.results[0]!.row.public_id).toBe(id21("ok", 1));
        expect(first.results[0]!.row.in_reply_to).toBe(id21("chain", REPLY_VISIT_LIMIT));

        expectStop(okResult(refused!), { index: 0, code: "limit_exceeded", path: "" });
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("response wire budget", () => {
  test(
    "a list page at exactly 16 MiB is served and one byte more is refused",
    async () => {
      const { openContextReader } = requireContextApi();
      const fixture = await createTaxonomyFixture([WORKSPACE]);
      try {
        // Solve for the padding that lands the rows ARRAY exactly on the limit.
        // Padding is 'a', one UTF-8 byte that JSON.stringify never escapes, so
        // the arithmetic is exact without materialising 16 MiB of strings.
        const count = 64;
        const shape = (extra: number): SeedMessage[] => {
          const bare = Array.from({ length: count }, (_, index) => ({
            id: BigInt(index + 1),
            public_id: id21("big", index + 1),
            seq: BigInt(index + 1),
          }));
          const deficit = RESPONSE_BUDGET_BYTES - expectedArrayBytes(bare.map(expectedRow));
          const per = Math.floor(deficit / count);
          const remainder = deficit - per * count + extra;
          return bare.map((seed, index) => ({
            ...seed,
            contentPad: per + (index === count - 1 ? remainder : 0),
          }));
        };

        const exact = shape(0);
        expect(expectedArrayBytes(exact.map(expectedRow))).toBe(RESPONSE_BUDGET_BYTES);

        await runPlan(fixture, [
          ...registrationSteps([{ workspace: WORKSPACE, session: SESSION }]),
          { op: "seed", table: "messages", rows: exact.map(seedRow) },
        ]);

        const reader = await openContextReader(fixture.datasetRoot);
        const page = await (reader as never as {
          context: {
            listMessages(b: Uint8Array): Promise<{ rows: Record<string, unknown>[] }>;
          };
        }).context.listMessages(
          encodeRequest({
            workspace_name: WORKSPACE,
            session_name: SESSION,
            after_seq: null,
            limit: count,
          }),
        );
        // Equality is accepted: the served array is exactly the budget.
        expect(page.rows.length).toBe(count);
        expect(expectedArrayBytes(page.rows)).toBe(RESPONSE_BUDGET_BYTES);
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "one byte over the budget is limit_exceeded, never a truncated page",
    async () => {
      const { openContextReader } = requireContextApi();
      const fixture = await createTaxonomyFixture([WORKSPACE]);
      try {
        const count = 64;
        const bare = Array.from({ length: count }, (_, index) => ({
          id: BigInt(index + 1),
          public_id: id21("big", index + 1),
          seq: BigInt(index + 1),
        }));
        const deficit = RESPONSE_BUDGET_BYTES - expectedArrayBytes(bare.map(expectedRow));
        const per = Math.floor(deficit / count);
        const over = bare.map((seed, index) => ({
          ...seed,
          contentPad: per + (index === count - 1 ? deficit - per * count + 1 : 0),
        }));
        expect(expectedArrayBytes(over.map(expectedRow))).toBe(RESPONSE_BUDGET_BYTES + 1);

        await runPlan(fixture, [
          ...registrationSteps([{ workspace: WORKSPACE, session: SESSION }]),
          { op: "seed", table: "messages", rows: over.map(seedRow) },
        ]);

        const reader = await openContextReader(fixture.datasetRoot);
        const error = await rejection(
          (reader as never as {
            context: { listMessages(b: Uint8Array): Promise<unknown> };
          }).context.listMessages(
            encodeRequest({
              workspace_name: WORKSPACE,
              session_name: SESSION,
              after_seq: null,
              limit: count,
            }),
          ),
        );
        expectEnvelope(error, {
          name: "PublicationError",
          version: "arra-publication-error/v1",
          code: "limit_exceeded",
          path: "",
        });
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a single row larger than the budget is refused by get",
    async () => {
      const { openContextReader } = requireContextApi();
      const fixture = await createTaxonomyFixture([WORKSPACE]);
      try {
        const publicId = id21("huge", 1);
        const bare: SeedMessage = { id: 1n, public_id: publicId, seq: 1n };
        const pad = RESPONSE_BUDGET_BYTES - expectedRowBytes(expectedRow(bare)) + 1;
        const huge: SeedMessage = { ...bare, contentPad: pad };
        expect(expectedRowBytes(expectedRow(huge))).toBe(RESPONSE_BUDGET_BYTES + 1);

        await runPlan(fixture, [
          ...registrationSteps([{ workspace: WORKSPACE, session: SESSION }]),
          { op: "seed", table: "messages", rows: [seedRow(huge)] },
        ]);

        const reader = await openContextReader(fixture.datasetRoot);
        const error = await rejection(
          (reader as never as {
            context: { getMessage(b: Uint8Array): Promise<unknown> };
          }).context.getMessage(encodeRequest({ workspace_name: WORKSPACE, public_id: publicId })),
        );
        expectEnvelope(error, {
          name: "PublicationError",
          version: "arra-publication-error/v1",
          code: "limit_exceeded",
          path: "",
        });
      } finally {
        await fixture.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
