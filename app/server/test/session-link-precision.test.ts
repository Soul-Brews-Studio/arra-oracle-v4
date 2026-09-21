/**
 * session-link-v1 precision evidence (session-link-v1 contract).
 *
 * Scope, per the dispatch: `created_at` is `timestamp[us] NOT NULL` -- exact
 * micros in, exact UTC-ms text out, a sub-millisecond remainder refused
 * closed, the Gregorian 0001/9999 bounds render and one microsecond outside
 * either bound never does. All eight physical columns wire exactly. The `id`
 * keyset page boundary is exact -- `created_at` is NOT unique and is never
 * the sort key. The cycle-walk bound: 1024 visited accepted, complementing
 * the accepted core lane's own proof that 1025 is `limit_exceeded` at ROOT.
 *
 * INDEPENDENT ORACLES. Every expected row is authored here as the eight
 * physical fields in contract order, never copied from a first materializer
 * output.
 *
 * TWO KINDS OF BAD STATE, DELIBERATELY LABELLED. A value this file writes
 * with raw Arrow is ENGINE-ADMITTED corruption: the store accepted it, so the
 * kernel must reject it on read. Whether the engine would ALSO admit some
 * other malformed value is a separate, unasked question -- this file never
 * infers engine enforcement from a NOT NULL declaration; pure-encoder
 * rejection of malformed input, independent of any engine, is core's proof.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGated } from "./helpers/publication-fixture";
import { createTaxonomyFixture, type TaxonomyFixture } from "./helpers/taxonomy-fixture";
import {
  createSessionLinkRequest,
  listSessionLinksRequest,
  sessionLinkId,
} from "./helpers/session-link-fixture";

const CHILD = new URL("./fixtures/session-link-v1/precision/seed-child.ts", import.meta.url).pathname;
const SEED_DEADLINE_MS = 300_000;
const TEST_TIMEOUT_MS = 600_000;

const W1 = "alpha-workspace";
const PEER = "peer-a";

const MICROS_PER_MS = 1000n;
const SEED_MS = 1789948800000n; // 2026-09-21T00:00:00.000Z
const SEED_MICROS = SEED_MS * MICROS_PER_MS;
const SEED_ISO = new Date(Number(SEED_MS)).toISOString();

/** The exact physical field order, per session-link.ts's SESSION_LINK_FIELDS. */
const SESSION_LINK_FIELDS = [
  "id", "workspace_name", "from_session_name", "to_session_name",
  "relation", "evidence_ref", "created_by_peer_name", "created_at",
] as const;

async function runPlan(fixture: TaxonomyFixture, steps: unknown[]): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), "arra-sl-precision-"));
  const planPath = join(dir, "plan.json");
  try {
    await writeFile(planPath, JSON.stringify({ datasetRoot: fixture.datasetRoot, steps }), "utf8");
    const run = await runGated(fixture.datasetRoot, CHILD, [planPath], { deadlineMs: SEED_DEADLINE_MS });
    if (run.code !== 0) throw new Error(`gated seed child failed (${run.code}): ${run.stderr.slice(0, 1200)}`);
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runAction(
  fixture: TaxonomyFixture,
  actions: { method: string; request: unknown }[],
  clock: { mode: "fixed"; ms: number } | { mode: "throw" } = { mode: "fixed", ms: Number(SEED_MS) },
): Promise<Array<{ ok: boolean; result?: Record<string, unknown>; name?: string; error?: Record<string, unknown> }>> {
  const output = await runPlan(fixture, [{ op: "action", clock, actions }]);
  const entry = (output.results as Record<string, unknown>[]).find((row) => row.op === "action");
  if (entry === undefined) throw new Error("child produced no action result");
  return entry.actions as never;
}

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

async function probeAdmission(
  fixture: TaxonomyFixture,
  table: string,
  rows: Record<string, unknown>[],
): Promise<{ admitted: true } | { admitted: false; refusal: { name: string | null; message: string } }> {
  const output = await runPlan(fixture, [{ op: "seed", table, rows, probe: true }]);
  const entry = (output.results as Record<string, unknown>[]).find((row) => row.op === "seed");
  if (entry === undefined) throw new Error("child produced no seed result");
  if (entry.admitted === true) return { admitted: true };
  const refusal = entry.refusal as { name: string | null; message: string } | undefined;
  if (refusal === undefined) throw new Error("child reported refusal without detail");
  return { admitted: false, refusal };
}

function registrationSteps(sessions: string[]): unknown[] {
  return [
    { op: "seed", table: "peers", rows: [{
      id: sessionLinkId("peer1"), name: PEER, workspace_name: W1, created_at: SEED_MICROS.toString(10),
    }] },
    { op: "seed", table: "sessions", rows: sessions.map((name, index) => ({
      id: sessionLinkId(`sess${index}`), name, workspace_name: W1, is_active: true,
      created_at: SEED_MICROS.toString(10),
    })) },
  ];
}

function sessionLinkRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: sessionLinkId("linkA"),
    workspace_name: W1,
    from_session_name: "sess-a",
    to_session_name: "sess-b",
    relation: "continues",
    evidence_ref: null,
    created_by_peer_name: null,
    created_at: SEED_MICROS.toString(10),
    ...overrides,
  };
}

async function corpus(sessions: string[] = ["sess-a", "sess-b"]): Promise<TaxonomyFixture> {
  const fixture = await createTaxonomyFixture([W1]);
  await runPlan(fixture, registrationSteps(sessions));
  return fixture;
}

describe("all eight physical columns wire exactly", () => {
  test("a fully-populated row and an all-null-optional row both round-trip through listSessionLinks", async () => {
    const fixture = await corpus();
    try {
      const [populated] = await runAction(fixture, [
        { method: "createSessionLink", request: createSessionLinkRequest(W1, {
          id: sessionLinkId("linkPop"),
          from_session_name: "sess-a",
          to_session_name: "sess-b",
          relation: "forked_from",
          evidence_ref: { target_kind: "session", target: { session_name: "sess-a" } },
          created_by_peer_name: PEER,
        }) },
      ]);
      expect(populated!.ok, JSON.stringify(populated)).toBe(true);
      const row = populated!.result!.row as Record<string, unknown>;
      expect(Object.keys(row)).toEqual([...SESSION_LINK_FIELDS]);
      expect(row).toEqual({
        id: sessionLinkId("linkPop"),
        workspace_name: W1,
        from_session_name: "sess-a",
        to_session_name: "sess-b",
        relation: "forked_from",
        evidence_ref: JSON.stringify({ target: { session_name: "sess-a" }, target_kind: "session" }),
        created_by_peer_name: PEER,
        created_at: SEED_ISO,
      } as never);

      const [empty] = await runAction(fixture, [
        { method: "createSessionLink", request: createSessionLinkRequest(W1, {
          id: sessionLinkId("linkNull"),
          from_session_name: "sess-b",
          to_session_name: "sess-a",
          relation: "related_to",
          evidence_ref: null,
          created_by_peer_name: null,
        }) },
      ]);
      expect(empty!.ok, JSON.stringify(empty)).toBe(true);
      const nullRow = empty!.result!.row as Record<string, unknown>;
      expect(Object.keys(nullRow)).toEqual([...SESSION_LINK_FIELDS]);
      expect(nullRow.evidence_ref).toBeNull();
      expect(nullRow.created_by_peer_name).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("created_at: timestamp[us] precision", () => {
  test("a sub-millisecond retained remainder fails closed on listSessionLinks", async () => {
    const fixture = await corpus();
    try {
      await runPlan(fixture, [
        { op: "seed", table: "session_links", rows: [sessionLinkRow({ created_at: (SEED_MICROS + 1n).toString(10) })] },
      ]);
      const [action] = await runAction(fixture, [
        { method: "listSessionLinks", request: listSessionLinksRequest(W1, { session_name: "sess-a", direction: "from" }) },
      ]);
      expect(action!.ok).toBe(false);
      expect(action).toMatchObject({
        name: "PublicationError",
        error: { version: "arra-publication-error/v1", code: "integrity_failure", path: "" },
      });
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("the Gregorian endpoints render exactly; one microsecond outside never does", async () => {
    const MIN_MS = -62135596800000n; // 0001-01-01T00:00:00.000Z
    const MAX_MS = 253402300799999n; // 9999-12-31T23:59:59.999Z
    const MIN_ISO = new Date(Number(MIN_MS)).toISOString();
    const MAX_ISO = new Date(Number(MAX_MS)).toISOString();
    expect(MIN_ISO).toBe("0001-01-01T00:00:00.000Z");
    expect(MAX_ISO).toBe("9999-12-31T23:59:59.999Z");

    for (const [ms, iso] of [[MIN_MS, MIN_ISO], [MAX_MS, MAX_ISO]] as [bigint, string][]) {
      const fixture = await corpus();
      try {
        await runPlan(fixture, [
          { op: "seed", table: "session_links", rows: [sessionLinkRow({ created_at: (ms * MICROS_PER_MS).toString(10) })] },
        ]);
        const [action] = await runAction(fixture, [
          { method: "listSessionLinks", request: listSessionLinksRequest(W1, { session_name: "sess-a", direction: "from" }) },
        ]);
        expect(action!.ok, JSON.stringify(action)).toBe(true);
        expect((action!.result!.rows as Record<string, unknown>[])[0]!.created_at).toBe(iso);
      } finally {
        await fixture.cleanup();
      }
    }

    for (const micros of [(MAX_MS + 1n) * MICROS_PER_MS, (MIN_MS - 1n) * MICROS_PER_MS]) {
      const fixture = await corpus();
      try {
        const admission = await probeAdmission(fixture, "session_links", [
          sessionLinkRow({ created_at: micros.toString(10) }),
        ]);
        if (admission.admitted) {
          const [action] = await runAction(fixture, [
            { method: "listSessionLinks", request: listSessionLinksRequest(W1, { session_name: "sess-a", direction: "from" }) },
          ]);
          expect(action!.ok).toBe(false);
          expect(action).toMatchObject({
            name: "PublicationError",
            error: { version: "arra-publication-error/v1", code: "integrity_failure", path: "" },
          });
        } else {
          expect(admission.refusal.message.length).toBeGreaterThan(0);
          expect(await storedRows(fixture, "session_links", `workspace_name = '${W1}'`)).toEqual([] as never);
        }
      } finally {
        await fixture.cleanup();
      }
    }
  }, TEST_TIMEOUT_MS);
});

describe("id keyset page boundary is exact", () => {
  test("created_at is tied across every row; id ascending is the only order, and the boundary lands exactly at the limit", async () => {
    const fixture = await corpus();
    try {
      const TOTAL = 101; // MAX_PAGE_LIMIT (100) + 1
      const pad = (i: number) => `zz${String(i).padStart(19, "0")}`.slice(0, 21);
      const rows = Array.from({ length: TOTAL }, (_, i) => sessionLinkRow({
        id: pad(i),
        to_session_name: `target-${i}`,
        created_at: SEED_MICROS.toString(10), // every row TIED on created_at
      }));
      await runPlan(fixture, [{ op: "seed", table: "session_links", rows }]);

      const [first] = await runAction(fixture, [
        { method: "listSessionLinks", request: listSessionLinksRequest(W1, {
          session_name: "sess-a", direction: "from", cursor: null, limit: 100,
        }) },
      ]);
      expect(first!.ok, JSON.stringify(first)).toBe(true);
      const firstRows = first!.result!.rows as Record<string, unknown>[];
      expect(firstRows).toHaveLength(100);
      // Ascending BY ID, not insertion order and not created_at (tied for all).
      expect(firstRows.map((r) => r.id)).toEqual(Array.from({ length: 100 }, (_, i) => pad(i)));
      expect(first!.result!.next_cursor).toBe(pad(99));

      const [second] = await runAction(fixture, [
        { method: "listSessionLinks", request: listSessionLinksRequest(W1, {
          session_name: "sess-a", direction: "from", cursor: first!.result!.next_cursor as string, limit: 100,
        }) },
      ]);
      expect(second!.ok, JSON.stringify(second)).toBe(true);
      const secondRows = second!.result!.rows as Record<string, unknown>[];
      // Exactly the ONE remaining row -- the cursor id itself is EXCLUDED
      // (id > cursor, strictly), not re-served.
      expect(secondRows).toHaveLength(1);
      expect(secondRows[0]!.id).toBe(pad(100));
      expect(second!.result!.next_cursor).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

describe("cycle-walk bound: the accepted side of the boundary", () => {
  test("exactly 1024 distinct finished sessions is accepted, not refused", async () => {
    // Complements the accepted core lane's own proof that 1025 fails: this is
    // the OTHER side of the same boundary. `black.size` counts EVERY finished
    // session including `sess-wide` itself (the walk's start node), so 1023
    // leaf targets plus sess-wide totals exactly MAX_CYCLE_VISITED (1024).
    const fixture = await corpus(["sess-a", "sess-wide"]);
    try {
      const WIDE_COUNT = 1023; // MAX_CYCLE_VISITED (1024) minus sess-wide itself
      const micros = SEED_MICROS.toString(10);
      const wideRows = Array.from({ length: WIDE_COUNT }, (_, i) => ({
        id: `wide${String(i).padStart(17, "0")}`,
        workspace_name: W1,
        from_session_name: "sess-wide",
        to_session_name: `wide-target-${i}`,
        relation: "continues",
        evidence_ref: null,
        created_by_peer_name: null,
        created_at: micros,
      }));
      expect(wideRows[0]!.id).toHaveLength(21);
      const seeded = await runPlan(fixture, [{ op: "seed", table: "session_links", rows: wideRows }]);
      const seedEntry = (seeded.results as Record<string, unknown>[])[0] as { added: number };
      expect(seedEntry.added).toBe(WIDE_COUNT);

      const [action] = await runAction(fixture, [
        { method: "createSessionLink", request: createSessionLinkRequest(W1, {
          id: sessionLinkId("linkToWide"), from_session_name: "sess-a", to_session_name: "sess-wide",
        }) },
      ]);
      expect(action!.ok, JSON.stringify(action)).toBe(true);
      expect(action!.result!.outcome).toBe("created");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
