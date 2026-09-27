/**
 * #29 TODO (AC-MATRIX row, ac-guards slice): `supersedeNode` must refuse a
 * node superseding ITSELF, and must refuse a 2-node supersede CYCLE
 * (A -> B, then B -> A). `service.supersedeNode.ts` already carries both
 * guards -- the immediate `request.new_node_id === request.node_id` check,
 * and the `walkForwardChain` scan before any successor state is read -- but
 * analysis-29.json found zero committed tests for either. This file is that
 * pin, proven against a real gated dataset, not the in-process kernel
 * directly.
 *
 * Both guards were verified red-by-mutation in this session (each guard
 * commented out in turn, this file's matching assertion failed, then the
 * guard was restored) rather than committing a mutation harness here.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/lifecycle-v1/core/gated-lifecycle.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");
const TEST_TIMEOUT_MS = testTimeout(180_000);

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const NODE_A = idOf("acgSelfCycleA");
const NODE_B = idOf("acgSelfCycleB");
const REV_A1 = idOf("acgSelfCycleRevA1");
const REV_B1 = idOf("acgSelfCycleRevB1");

const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });

const drive = async (fixture: Fixture, ops: Array<Record<string, unknown>>, revisionIds: string[]) => {
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ ops, revisionIds, clockMs: CLOCK_MS }),
  ]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
  return JSON.parse(line) as Record<string, any>;
};

const ok = (op: any, label: string) => {
  expect(op?.ok, `${label}: ${JSON.stringify(op).slice(0, 500)}`).toBe(true);
  return op.value;
};
const refusedNewNodeId = (op: any, label: string) => {
  expect(op?.ok, `${label} expected a refusal, got ${JSON.stringify(op)}`).toBe(false);
  expect(op.code, label).toBe("invalid_request");
  expect(op.path, label).toBe("/new_node_id");
};

describe("#29: supersedeNode refuses self-supersede and a 2-node cycle", () => {
  test("A superseding itself is refused; A->B then B->A (a 2-node cycle) is refused", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;

      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-acg-a1", content: revisionEnvelope(ALPHA, alpha, NODE_A) }),
          pub("publishRevision", { operation_id: "op-acg-b1", content: revisionEnvelope(ALPHA, alpha, NODE_B) }),
          // (1) self-supersede: A -> A.
          ctx("supersedeNode", {
            workspace_name: ALPHA,
            node_id: NODE_A,
            expected_revision_id: REV_A1,
            new_node_id: NODE_A,
            new_revision_id: REV_A1,
            reason: "self-supersede probe",
            peer_name: null,
            operation_id: "op-acg-self",
          }),
          // A is still fully eligible: the refused self-supersede wrote nothing.
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_A }),
          // (2) set up a real forward edge A -> B, so a later B -> A closes a cycle.
          ctx("supersedeNode", {
            workspace_name: ALPHA,
            node_id: NODE_A,
            expected_revision_id: REV_A1,
            new_node_id: NODE_B,
            new_revision_id: REV_B1,
            reason: "genuine A -> B supersede",
            peer_name: null,
            operation_id: "op-acg-a-to-b",
          }),
          // (3) the 2-node cycle: B -> A. B's own new_node_id/new_revision_id
          // point back at A, which already has a forward edge to B.
          ctx("supersedeNode", {
            workspace_name: ALPHA,
            node_id: NODE_B,
            expected_revision_id: REV_B1,
            new_node_id: NODE_A,
            new_revision_id: REV_A1,
            reason: "2-node cycle probe: B -> A",
            peer_name: null,
            operation_id: "op-acg-b-to-a",
          }),
          // B is still exactly what the accepted A->B event made it: no
          // second event, no cycle write.
          ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: NODE_A, after_event_id: null, limit: 10 }),
        ],
        [REV_A1, REV_B1],
      );

      refusedNewNodeId(parsed.op2, "(1) self-supersede A -> A");
      expect(ok(parsed.op3, "A still eligible after refused self-supersede")).toMatchObject({
        eligible: true,
        reasons: [],
      });

      expect(ok(parsed.op4, "(2) genuine A -> B supersede").outcome).toBe("accepted");

      refusedNewNodeId(parsed.op5, "(3) 2-node cycle B -> A");

      const history = ok(parsed.op6, "history after the refused cycle attempt");
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0]).toMatchObject({ old_id: NODE_A, new_id: NODE_B });
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
