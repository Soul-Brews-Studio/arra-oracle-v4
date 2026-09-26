/**
 * #29 AC1 (analysis-29.json tests 2(f)/(g)): a `correction`-typed node, and a
 * `corrects` link into an existing node's accepted revision, are both
 * ordinary publication content -- neither one is itself a lifecycle event,
 * so neither should change the eligibility of anything.
 *
 * Flagged in the fix round as still untracked by any test and unmentioned in
 * the slice report; this file closes that gap. It is regression coverage,
 * not a bug fix: nothing in `evaluateNodeEligibility`/`listNodes` reads
 * `term_snapshot_json`'s type term or `link_snapshot_json` at all (only
 * `supersede_log` decides eligibility), so this is expected to pass without
 * any source change -- the point is that it is now PROVEN, not assumed.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/lifecycle-v1/core/gated-lifecycle.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const tax = (method: string, request: unknown) => ({ facade: "taxonomy", method, request });

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

const listNodesReq = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  after_id: null,
  limit: 100,
  include_total: true,
  type_term: null,
  include_inactive: false,
  ...overrides,
});

describe("#29 AC1: a correction-typed node, and a corrects link, leave eligibility unchanged", () => {
  test("publishing a correction-typed node with no base/link is accepted", async () => {
    const CORRECTION_TERM = idOf("ac1CorrectionTerm");
    const NODE_CORR = idOf("ac1NodeCorrection");
    const REV_CORR = idOf("ac1RevCorrection");

    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const correctionEnvelope = revisionEnvelope(ALPHA, alpha, NODE_CORR, {
        title: "a correction",
        term_snapshot_json: JSON.stringify([
          {
            term_id: CORRECTION_TERM,
            vocabulary_id: alpha.vocabulary_ids.type,
            vocabulary_name_snapshot: "type",
            term_name_snapshot: "correction",
            label_snapshot: null,
            position: "0",
          },
        ]),
      });

      const parsed = await drive(
        fixture,
        [
          // The fixture only seeds "note"/"decision" under "type" -- add
          // "correction" (one of the reserved TYPE_TERMS) so this revision's
          // snapshot can name it. "type" is term_policy "open" (R6 only
          // seals "topic" in this fixture), so createTerm is not refused.
          tax("createTerm", {
            workspace_name: ALPHA,
            term_id: CORRECTION_TERM,
            vocabulary_id: alpha.vocabulary_ids.type,
            name: "correction",
            description: null,
            parent_id: null,
          }),
          pub("publishRevision", { operation_id: "op-ac1-correction", content: correctionEnvelope }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_CORR }),
        ],
        [REV_CORR],
      );

      expect(ok(parsed.op0, "createTerm correction").outcome).toBe("created");
      expect(ok(parsed.op1, "publish correction-typed node").outcome).toBe("accepted");
      expect(ok(parsed.op2, "correction node is eligible")).toMatchObject({ eligible: true, reasons: [] });
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(180_000));

  test("a corrects link into A's accepted revision leaves A eligible, with zero supersede_log rows, still in listNodes' default view", async () => {
    const NODE_A = idOf("ac1NodeA");
    const NODE_E = idOf("ac1NodeE");
    const REV_A1 = idOf("ac1RevA1");
    const REV_E1 = idOf("ac1RevE1");

    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const correctsLinkEnvelope = revisionEnvelope(ALPHA, alpha, NODE_E, {
        title: "a correction of A",
        link_snapshot_json: JSON.stringify([
          {
            position: "0",
            relation: "corrects",
            target_kind: "node_revision",
            target: { node_id: NODE_A, revision_id: REV_A1 },
            excerpt: null,
            content_hash: null,
            captured_at: null,
            capture_status: "locator_only",
            note: null,
          },
        ]),
      });

      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-ac1-a", content: revisionEnvelope(ALPHA, alpha, NODE_A) }),
          pub("publishRevision", { operation_id: "op-ac1-e", content: correctsLinkEnvelope }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_A }),
          ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: NODE_A, after_event_id: null, limit: 10 }),
          pub("listNodes", listNodesReq()),
        ],
        [REV_A1, REV_E1],
      );

      expect(ok(parsed.op0, "publish A").outcome).toBe("accepted");
      expect(ok(parsed.op1, "publish E with a corrects link to A").outcome).toBe("accepted");

      // A is still fully eligible -- a `corrects` link is content, not a
      // lifecycle event.
      expect(ok(parsed.op2, "A still eligible")).toMatchObject({ eligible: true, reasons: [] });
      // Zero supersede_log rows for A: the link created no terminal event.
      expect(ok(parsed.op3, "A's lifecycle history is empty").rows).toEqual([]);
      // A is still in listNodes' default (current) view.
      const current = ok(parsed.op4, "listNodes current");
      const ids = current.rows.map((r: any) => r.id);
      expect(ids).toContain(NODE_A);
      expect(current.total).toBe("2"); // A and E, neither terminal
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(180_000));
});
