/**
 * #29 (Parent #28) node lifecycle kernel: one smoke test.
 *
 * Proves supersede writes one event and flips eligibility, retire works,
 * replay by operation_id is idempotent with no second row, a stale
 * expected_revision_id conflicts, and history lists the events. Exhaustive
 * coverage of every fault class is deliberately NOT here; that comes later.
 */

import { describe, expect, test } from "bun:test";
import {
  createFixture,
  revisionEnvelope,
  runGated,
  type Fixture,
} from "./helpers/publication-fixture";

const CHILD = new URL("./fixtures/lifecycle-v1/core/gated-lifecycle.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const NODE_A = idOf("nodeAlifecycle");
const NODE_B = idOf("nodeBlifecycle");
const NODE_C = idOf("nodeClifecycle");
const NODE_D = idOf("nodeDlifecycle");
const REV_A1 = idOf("revAlifecycle1");
const REV_B1 = idOf("revBlifecycle1");
const REV_C1 = idOf("revClifecycle1");
const REV_D1 = idOf("revDlifecycle1");

const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

const drive = async (
  fixture: Fixture,
  ops: Array<Record<string, unknown>>,
  revisionIds: string[],
): Promise<Record<string, any>> => {
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ ops, revisionIds, clockMs: CLOCK_MS }),
  ]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
  return JSON.parse(line);
};

describe("preflight: the required surface", () => {
  test("the pure module exists and exports its grammar", async () => {
    const mod = await import("../src/publication/lifecycle").catch((error) => ({
      __absent: String(error),
    }));
    expect(mod).not.toHaveProperty("__absent");
    expect(typeof (mod as Record<string, unknown>).parseSupersedeNode).toBe("function");
    expect(typeof (mod as Record<string, unknown>).parseRetireNode).toBe("function");
    expect(typeof (mod as Record<string, unknown>).parseGetRecallEligibility).toBe("function");
    expect(typeof (mod as Record<string, unknown>).parseListLifecycleHistory).toBe("function");
    expect(typeof (mod as Record<string, unknown>).encodeSupersedeLogRow).toBe("function");
  });
});

describe("real persistence: lifecycle events inside the real gate", () => {
  test("supersede writes one event and flips eligibility; retire works; replay is idempotent; a stale pin conflicts; history lists the events", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const supersedeRequest = (overrides: Record<string, unknown> = {}) => ({
        workspace_name: ALPHA,
        node_id: NODE_A,
        expected_revision_id: REV_A1,
        new_node_id: NODE_B,
        new_revision_id: REV_B1,
        reason: "superseded by a newer note",
        peer_name: null,
        operation_id: "op-supersede-1",
        ...overrides,
      });

      const parsed = await drive(fixture, [
        pub("publishRevision", { operation_id: "op-a1", content: revisionEnvelope(ALPHA, alpha, NODE_A) }),
        pub("publishRevision", { operation_id: "op-b1", content: revisionEnvelope(ALPHA, alpha, NODE_B) }),
        pub("publishRevision", { operation_id: "op-c1", content: revisionEnvelope(ALPHA, alpha, NODE_C) }),
        // Eligibility BEFORE any lifecycle event: A is eligible.
        ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_A }),
        // Supersede A -> B.
        ctx("supersedeNode", supersedeRequest()),
        ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_A }),
        ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_B }),
        // Retire C, an unrelated node.
        ctx("retireNode", {
          workspace_name: ALPHA,
          node_id: NODE_C,
          expected_revision_id: REV_C1,
          reason: "no longer needed",
          peer_name: null,
          operation_id: "op-retire-1",
        }),
        ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_C }),
        // EXACT replay of the same supersede operation: idempotent, no write.
        ctx("supersedeNode", supersedeRequest()),
        hx("readRawRows", {
          table: "supersede_log",
          predicate: `workspace_name = '${ALPHA}' AND old_id = '${NODE_A}'`,
        }),
        // A STALE pin: C's real head is REV_C1, not REV_A1.
        ctx("retireNode", {
          workspace_name: ALPHA,
          node_id: NODE_C,
          expected_revision_id: REV_A1,
          reason: "wrong pin",
          peer_name: null,
          operation_id: "op-retire-stale",
        }),
        // History for A (the supersede event) and C (the retire event).
        ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: NODE_A, after_event_id: null, limit: 10 }),
        ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: NODE_C, after_event_id: null, limit: 10 }),
      ], [REV_A1, REV_B1, REV_C1]);

      // Eligible before any event.
      expect(parsed.op3.ok, JSON.stringify(parsed.op3)).toBe(true);
      expect(parsed.op3.value.eligible).toBe(true);

      // Supersede accepted.
      const superseded = parsed.op4;
      expect(superseded.ok, JSON.stringify(superseded)).toBe(true);
      expect(superseded.value.outcome).toBe("accepted");
      expect(superseded.value.row.old_id).toBe(NODE_A);
      expect(superseded.value.row.old_revision_id).toBe(REV_A1);
      expect(superseded.value.row.new_id).toBe(NODE_B);
      expect(superseded.value.row.new_revision_id).toBe(REV_B1);
      expect(superseded.value.row.old_title).toBe("a title");
      expect(superseded.value.row.old_type).toBe(alpha.term_ids.type.note.name);
      expect(superseded.value.row.old_source).toBeNull();
      expect(superseded.value.row.new_source).toBeNull();
      const eventId = superseded.value.row.id;

      // A is now ineligible; B, never itself superseded/retired, stays eligible.
      expect(parsed.op5.value.eligible).toBe(false);
      expect(parsed.op6.value.eligible).toBe(true);

      // Retire accepted.
      const retired = parsed.op7;
      expect(retired.ok, JSON.stringify(retired)).toBe(true);
      expect(retired.value.outcome).toBe("accepted");
      expect(retired.value.row.old_id).toBe(NODE_C);
      expect(retired.value.row.new_id).toBeNull();
      expect(retired.value.row.new_revision_id).toBeNull();
      expect(retired.value.row.new_title).toBeNull();

      expect(parsed.op8.value.eligible).toBe(false);

      // Exact replay: the ORIGINAL row, no second write.
      const replay = parsed.op9;
      expect(replay.ok, JSON.stringify(replay)).toBe(true);
      expect(replay.value.outcome).toBe("idempotent");
      expect(replay.value.row).toEqual(superseded.value.row);

      const rawRows = parsed.op10.value;
      expect(rawRows).toHaveLength(1);
      expect(rawRows[0].id).toBe(String(eventId));

      // A stale pin against C (whose real head is REV_C1, not REV_A1) conflicts.
      const stalePin = parsed.op11;
      expect(stalePin.ok, JSON.stringify(stalePin)).toBe(true);
      expect(stalePin.value).toEqual({ outcome: "conflict", reason: "stale_pin", row: null });

      // History lists exactly the one event each.
      const historyA = parsed.op12;
      expect(historyA.ok, JSON.stringify(historyA)).toBe(true);
      expect(historyA.value.rows).toHaveLength(1);
      expect(historyA.value.rows[0].id).toBe(String(eventId));
      expect(historyA.value.rows[0].new_id).toBe(NODE_B);
      expect(historyA.value.next_after_event_id).toBeNull();

      const historyC = parsed.op13;
      expect(historyC.ok, JSON.stringify(historyC)).toBe(true);
      expect(historyC.value.rows).toHaveLength(1);
      expect(historyC.value.rows[0].old_id).toBe(NODE_C);
      expect(historyC.value.rows[0].new_id).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a retired node refuses a new revision, but a pre-retirement publish replay still returns idempotent", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const parsed = await drive(fixture, [
        pub("publishRevision", { operation_id: "op-d1", content: revisionEnvelope(ALPHA, alpha, NODE_D) }),
        ctx("retireNode", {
          workspace_name: ALPHA,
          node_id: NODE_D,
          expected_revision_id: REV_D1,
          reason: "terminal",
          peer_name: null,
          operation_id: "op-retire-d",
        }),
        // A replay of the ORIGINAL publish, after retirement: still idempotent.
        pub("publishRevision", { operation_id: "op-d1", content: revisionEnvelope(ALPHA, alpha, NODE_D) }),
        // A genuinely NEW revision on the retired node: refused.
        pub("publishRevision", {
          operation_id: "op-d2",
          content: revisionEnvelope(ALPHA, alpha, NODE_D, { base_revision_id: REV_D1 }),
        }),
      ], [REV_D1]);

      expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
      expect(parsed.op0.value.outcome).toBe("accepted");
      expect(parsed.op1.ok, JSON.stringify(parsed.op1)).toBe(true);
      expect(parsed.op1.value.outcome).toBe("accepted");
      expect(parsed.op2.ok, JSON.stringify(parsed.op2)).toBe(true);
      expect(parsed.op2.value.outcome).toBe("idempotent");
      expect(parsed.op3.ok, JSON.stringify(parsed.op3)).toBe(true);
      expect(parsed.op3.value).toEqual({ outcome: "conflict", reason: "node_retired" });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
});
