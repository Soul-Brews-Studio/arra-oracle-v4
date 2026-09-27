/**
 * #29 AC4 (AC-MATRIX row, ac-guards slice): "no read-driven writes."
 * `getRecallEligibility` and `listNodes` are reads: calling either must
 * change nothing about `nodes`, `node_revisions` or `supersede_log` --
 * neither the dataset VERSION (a LanceDB table version bumps on every
 * committed write) nor the ROW COUNT. No committed test measured this;
 * analysis-29.json and the AC-MATRIX both flag it as inspection-only.
 *
 * Measured with the harness's real `snapshot` op (table version + row count
 * straight off the LanceDB handle), taken before and after a batch of reads
 * inside the SAME gated child process the writer used to seed the fixture --
 * so "unchanged" is a real before/after equality, not an assumption.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/lifecycle-v1/ac-guards/gated-ac-guards.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");
const TEST_TIMEOUT_MS = testTimeout(180_000);

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const NODE_A = idOf("acgReadonlyA");
const NODE_B = idOf("acgReadonlyB");
const REV_A1 = idOf("acgReadonlyRevA1");
const REV_B1 = idOf("acgReadonlyRevB1");

const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

const TABLES = ["nodes", "node_revisions", "supersede_log"];

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

describe("#29 AC4: getRecallEligibility and listNodes never write", () => {
  test("dataset version and row count are byte-identical for nodes/node_revisions/supersede_log across a batch of eligibility and listNodes reads", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;

      const parsed = await drive(
        fixture,
        [
          // Seed: two nodes, then a real lifecycle event, so all three
          // tables have real rows and supersede_log is non-empty before the
          // reads under test even begin.
          pub("publishRevision", { operation_id: "op-acg-ro-a1", content: revisionEnvelope(ALPHA, alpha, NODE_A) }),
          pub("publishRevision", { operation_id: "op-acg-ro-b1", content: revisionEnvelope(ALPHA, alpha, NODE_B) }),
          ctx("supersedeNode", {
            workspace_name: ALPHA,
            node_id: NODE_A,
            expected_revision_id: REV_A1,
            new_node_id: NODE_B,
            new_revision_id: REV_B1,
            reason: "seed a real lifecycle event before the read-only probe",
            peer_name: null,
            operation_id: "op-acg-ro-supersede",
          }),
          hx("snapshot", { tables: TABLES }),
          // The reads under test: eligibility on both nodes, twice each, plus
          // two shapes of listNodes (default view and include_inactive).
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_A }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_A }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_B }),
          pub("listNodes", {
            workspace_name: ALPHA,
            after_id: null,
            limit: 100,
            include_total: true,
            type_term: null,
            include_inactive: false,
          }),
          pub("listNodes", {
            workspace_name: ALPHA,
            after_id: null,
            limit: 100,
            include_total: true,
            type_term: null,
            include_inactive: true,
          }),
          hx("snapshot", { tables: TABLES }),
        ],
        [REV_A1, REV_B1],
      );

      expect(ok(parsed.op0, "publish A").outcome).toBe("accepted");
      expect(ok(parsed.op1, "publish B").outcome).toBe("accepted");
      expect(ok(parsed.op2, "seed supersede").outcome).toBe("accepted");

      const before = ok(parsed.op3, "snapshot before the reads");
      // Sanity: supersede_log genuinely has a row, so "unchanged" below is
      // measuring a real non-empty table, not three tables of zero rows.
      expect(before.supersede_log.rows).toBeGreaterThan(0);

      ok(parsed.op4, "eligibility A (1)");
      ok(parsed.op5, "eligibility A (2)");
      ok(parsed.op6, "eligibility B");
      ok(parsed.op7, "listNodes default view");
      ok(parsed.op8, "listNodes include_inactive");

      const after = ok(parsed.op9, "snapshot after the reads");

      expect(after).toEqual(before);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
