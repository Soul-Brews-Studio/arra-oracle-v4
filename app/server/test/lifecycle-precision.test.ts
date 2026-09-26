/**
 * lifecycle-v1 precision evidence (node lifecycle / `supersede_log`).
 *
 * Scope, per the dispatch: the int64 event `id` at the Int64 ceiling -- an
 * allocation that would overflow stops BEFORE any write; `superseded_at`
 * exact micros round-trip with a sub-millisecond remainder refused; all
 * sixteen `supersede_log` columns wire exactly, int64 as canonical decimal
 * TEXT, never a JS Number; the half-null `new_id`/`new_revision_id` pair is
 * `integrity_failure` (there is no event-kind column, so null-ness is the
 * only discriminator).
 *
 * TWO KINDS OF BAD STATE, DELIBERATELY LABELLED. A value this file writes
 * with raw Arrow is ENGINE-ADMITTED corruption: the store accepted it, so the
 * kernel must reject it on read. This file never infers engine enforcement
 * from a NOT NULL declaration; pure-encoder rejection of malformed input,
 * independent of any engine, is core's proof.
 *
 * The `id` allocator is GLOBAL, not per-workspace (`selectedMaximum(writer,
 * SUPERSEDE_LOG, "id", "true")` in service.ts) -- planting a max-id row in
 * ANY workspace controls the next allocation everywhere, which is exactly
 * what the ceiling tests below rely on.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, idSource, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";

const CHILD = new URL("./fixtures/lifecycle-v1/precision/seed-child.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");
const CLOCK_ISO = new Date(CLOCK_MS).toISOString();

const nodeId = idSource("nodeLc");
const revId = idSource("revLc");

const SUPERSEDE_LOG_FIELDS = [
  "id", "workspace_name", "old_id", "old_revision_id", "old_title", "old_type", "old_source",
  "new_id", "new_revision_id", "new_title", "new_source", "reason", "peer_name",
  "superseded_at", "operation_id", "h_metadata",
] as const;

const INT64_CEILING = 9223372036854775807n; // 2^63 - 1

const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

const drive = async (
  fixture: Fixture,
  ops: Array<Record<string, unknown>>,
  revisionIds: string[] = [],
): Promise<Record<string, any>> => {
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ ops, revisionIds, clockMs: CLOCK_MS }),
  ]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 1200)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 1200)}`);
  return JSON.parse(line);
};

/** A retirement-shaped raw row (new_id/new_revision_id both null): the only
 *  spelling the codec accepts besides "both non-null". */
function rawRetireRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1",
    workspace_name: ALPHA,
    old_id: nodeId(),
    old_revision_id: revId(),
    old_title: "t",
    old_type: "note",
    new_id: null,
    new_revision_id: null,
    new_title: null,
    reason: "r",
    peer_name: null,
    superseded_at_micros: (BigInt(CLOCK_MS) * 1000n).toString(10),
    operation_id: `op-${Math.random()}`,
    ...overrides,
  };
}

describe("all sixteen physical columns wire exactly", () => {
  test("a real supersede event round-trips through listLifecycleHistory with the id as canonical decimal TEXT", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const nodeA = nodeId();
      const nodeB = nodeId();
      const revA = revId();
      const revB = revId();
      const parsed = await drive(fixture, [
        pub("publishRevision", { operation_id: "op-a", content: revisionEnvelope(ALPHA, alpha, nodeA) }),
        pub("publishRevision", { operation_id: "op-b", content: revisionEnvelope(ALPHA, alpha, nodeB) }),
        ctx("supersedeNode", {
          workspace_name: ALPHA, node_id: nodeA, expected_revision_id: revA,
          new_node_id: nodeB, new_revision_id: revB, reason: "superseded",
          // A seeded peer of ALPHA: peer_name is a scoped reference since the
          // lifecycle-v1 amendment of 2026-09-26 (#10).
          peer_name: alpha.peer_names[0], operation_id: "op-supersede",
        }),
        ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: nodeA, after_event_id: null, limit: 10 }),
      ], [revA, revB]);

      const superseded = parsed.op2;
      expect(superseded.ok, JSON.stringify(superseded)).toBe(true);
      expect(superseded.value.outcome).toBe("accepted");
      const row = superseded.value.row as Record<string, unknown>;
      expect(Object.keys(row)).toEqual([...SUPERSEDE_LOG_FIELDS]);
      expect(typeof row.id).toBe("string");
      expect(row).toMatchObject({
        workspace_name: ALPHA, old_id: nodeA, old_revision_id: revA,
        old_title: "a title", old_type: alpha.term_ids.type.note.name, old_source: null,
        new_id: nodeB, new_revision_id: revB, new_title: "a title", new_source: null,
        reason: "superseded", peer_name: alpha.peer_names[0], superseded_at: CLOCK_ISO,
        operation_id: "op-supersede", h_metadata: null,
      });

      const history = parsed.op3;
      expect(history.ok, JSON.stringify(history)).toBe(true);
      expect(history.value.rows).toHaveLength(1);
      expect(Object.keys(history.value.rows[0])).toEqual([...SUPERSEDE_LOG_FIELDS]);
      expect(history.value.rows[0]).toEqual(row as never);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
});

describe("the Int64 ceiling: an allocation that would overflow stops BEFORE any write", () => {
  test("a global max id AT the ceiling refuses the next allocation, with no clock sample and no write", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const nodeC = nodeId();
      const revC = revId();
      const parsed = await drive(fixture, [
        pub("publishRevision", { operation_id: "op-c", content: revisionEnvelope(ALPHA, alpha, nodeC) }),
        hx("insertRawSupersedeLog", { rows: [rawRetireRow({ id: INT64_CEILING.toString(10) })] }),
        hx("snapshot", { tables: ["supersede_log"] }),
        ctx("retireNode", {
          workspace_name: ALPHA, node_id: nodeC, expected_revision_id: revC,
          reason: "would overflow", peer_name: null, operation_id: "op-retire-overflow",
        }),
        hx("snapshot", { tables: ["supersede_log"] }),
      ], [revC]);

      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      expect(parsed.op1.value.inserted).toBe(1);

      const before = parsed.op2.value as Record<string, { version: number; rows: number }>;
      const attempt = parsed.op3;
      expect(attempt.ok).toBe(false);
      expect(attempt).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "integrity_failure",
        path: "",
      });
      const after = parsed.op4.value as Record<string, { version: number; rows: number }>;
      // NO write: identical version and row count.
      expect(after).toEqual(before as never);
      // NO clock sample either: the allocation check runs before options.clock().
      expect(parsed.clockCalls).toBe(1); // the one real publishRevision above only
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("one BELOW the ceiling allocates exactly the ceiling, as canonical decimal TEXT", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const nodeD = nodeId();
      const revD = revId();
      const parsed = await drive(fixture, [
        pub("publishRevision", { operation_id: "op-d", content: revisionEnvelope(ALPHA, alpha, nodeD) }),
        hx("insertRawSupersedeLog", { rows: [rawRetireRow({ id: (INT64_CEILING - 1n).toString(10) })] }),
        ctx("retireNode", {
          workspace_name: ALPHA, node_id: nodeD, expected_revision_id: revD,
          reason: "lands on the ceiling", peer_name: null, operation_id: "op-retire-ceiling",
        }),
      ], [revD]);

      expect(parsed.op1.value.inserted).toBe(1);
      const retired = parsed.op2;
      expect(retired.ok, JSON.stringify(retired)).toBe(true);
      expect(retired.value.outcome).toBe("accepted");
      // A JS Number here would silently round; the assertion is on the exact
      // decimal STRING.
      expect(retired.value.row.id).toBe(INT64_CEILING.toString(10));
      expect(typeof retired.value.row.id).toBe("string");
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
});

describe("superseded_at: timestamp[us] precision", () => {
  test("a sub-millisecond retained remainder fails closed on listLifecycleHistory", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const nodeE = nodeId();
      const micros = (BigInt(CLOCK_MS) * 1000n + 1n).toString(10); // +1us remainder
      const parsed = await drive(fixture, [
        pub("publishRevision", { operation_id: "op-e", content: revisionEnvelope(ALPHA, alpha, nodeE) }),
        hx("insertRawSupersedeLog", { rows: [rawRetireRow({ id: "1", old_id: nodeE, superseded_at_micros: micros })] }),
        ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: nodeE, after_event_id: null, limit: 10 }),
      ]);
      const action = parsed.op2;
      expect(action.ok).toBe(false);
      expect(action).toMatchObject({
        name: "PublicationError", version: "arra-publication-error/v1", code: "integrity_failure", path: "",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("the Gregorian endpoints render exactly; one microsecond outside never does", async () => {
    const MIN_MS = -62135596800000n; // 0001-01-01T00:00:00.000Z
    const MAX_MS = 253402300799999n; // 9999-12-31T23:59:59.999Z
    const MIN_ISO = new Date(Number(MIN_MS)).toISOString();
    const MAX_ISO = new Date(Number(MAX_MS)).toISOString();
    expect(MIN_ISO).toBe("0001-01-01T00:00:00.000Z");
    expect(MAX_ISO).toBe("9999-12-31T23:59:59.999Z");

    for (const [ms, iso] of [[MIN_MS, MIN_ISO], [MAX_MS, MAX_ISO]] as [bigint, string][]) {
      const fixture = await createFixture([ALPHA]);
      try {
        const alpha = fixture.workspaces[ALPHA]!;
        const node = nodeId();
        const parsed = await drive(fixture, [
          pub("publishRevision", { operation_id: `op-${ms}`, content: revisionEnvelope(ALPHA, alpha, node) }),
          hx("insertRawSupersedeLog", { rows: [rawRetireRow({ id: "1", old_id: node, superseded_at_micros: (ms * 1000n).toString(10) })] }),
          ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: node, after_event_id: null, limit: 10 }),
        ]);
        const action = parsed.op2;
        expect(action.ok, JSON.stringify(action)).toBe(true);
        expect(action.value.rows[0].superseded_at).toBe(iso);
      } finally {
        await fixture.cleanup();
      }
    }

    for (const micros of [(MAX_MS + 1n) * 1000n, (MIN_MS - 1n) * 1000n]) {
      const fixture = await createFixture([ALPHA]);
      try {
        const alpha = fixture.workspaces[ALPHA]!;
        const node = nodeId();
        const setup = await drive(fixture, [
          pub("publishRevision", { operation_id: `op-${micros}`, content: revisionEnvelope(ALPHA, alpha, node) }),
          hx("probeSupersedeLog", { rows: [rawRetireRow({ id: "1", old_id: node, superseded_at_micros: micros.toString(10) })] }),
        ]);
        expect(setup.op0.ok, JSON.stringify(setup.op0)).toBe(true);
        const probe = setup.op1.value as { admitted: boolean; refusal?: { message: string } };
        if (probe.admitted) {
          const parsed = await drive(fixture, [
            ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: node, after_event_id: null, limit: 10 }),
          ]);
          expect(parsed.op0.ok).toBe(false);
          expect(parsed.op0).toMatchObject({
            name: "PublicationError", version: "arra-publication-error/v1", code: "integrity_failure", path: "",
          });
        } else {
          expect(probe.refusal!.message.length).toBeGreaterThan(0);
          const rows = await drive(fixture, [
            hx("readRawRows", { table: "supersede_log", predicate: `workspace_name = '${ALPHA}'` }),
          ]);
          expect(rows.op0.value).toEqual([] as never);
        }
      } finally {
        await fixture.cleanup();
      }
    }
  }, 300_000);
});

describe("the half-null successor pair has no event-kind column to fall back on", () => {
  test("exactly one of new_id/new_revision_id null is integrity_failure, never guessed", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const node = nodeId();
      const parsed = await drive(fixture, [
        pub("publishRevision", { operation_id: "op-half", content: revisionEnvelope(ALPHA, alpha, node) }),
        hx("insertRawSupersedeLog", {
          rows: [rawRetireRow({ id: "1", old_id: node, new_id: nodeId(), new_revision_id: null })],
        }),
        ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: node, after_event_id: null, limit: 10 }),
      ]);
      const action = parsed.op2;
      expect(action.ok).toBe(false);
      expect(action).toMatchObject({
        name: "PublicationError", version: "arra-publication-error/v1", code: "integrity_failure", path: "",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
});
