/**
 * #29 slice B (overnight R7): eligibility ENFORCEMENT at write time, split
 * out of `lifecycle-eligibility.test.ts` to stay under Nat's 500-line cap.
 *
 * That file covers the READ surface (what `listNodes`/`getAcceptedHead`/
 * `getRecallEligibility` show, by default, with `include_inactive`, across
 * pagination, and across the validity window); its header comment has the
 * full fixture/child-harness rationale. This file covers the two places a
 * terminal node's state is enforced rather than merely reported:
 * `supersedeNode` refusing to write a successor pointer into an
 * already-terminal node, and the search-chunk read paths
 * (`reconcileSearchChunks`/`indexRevisionChunks`) treating a terminal node
 * as `ineligible` rather than as an ordinary backfill gap. Same fixture and
 * `gated-lifecycle.ts` child harness as the companion file, no test or
 * assertion dropped in the split.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { activeEmbeddingProfileId } from "../src/publication/search-chunk";

const CHILD = new URL("./fixtures/lifecycle-v1/core/gated-lifecycle.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");

const idOf = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });

const drive = async (
  fixture: Fixture,
  ops: Array<Record<string, unknown>>,
  revisionIds: string[],
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>> => {
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ ops, revisionIds, clockMs: CLOCK_MS, ...extra }),
  ]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
  return JSON.parse(line);
};

const ok = (op: any, label: string) => {
  expect(op?.ok, `${label}: ${JSON.stringify(op).slice(0, 500)}`).toBe(true);
  return op.value;
};

describe("#29 slice B: superseding into an already-terminal successor is refused", () => {
  test("into an already-retired successor, and into an already-superseded one", async () => {
    const NODE_P = idOf("eligP");
    const NODE_Q = idOf("eligQ");
    const NODE_X = idOf("eligX");
    const NODE_Y = idOf("eligY");
    const NODE_W = idOf("eligW");
    const REV_P1 = idOf("eligP1");
    const REV_Q1 = idOf("eligQ1");
    const REV_X1 = idOf("eligX1");
    const REV_Y1 = idOf("eligY1");
    const REV_W1 = idOf("eligW1");

    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-p", content: revisionEnvelope(ALPHA, alpha, NODE_P) }),
          pub("publishRevision", { operation_id: "op-q", content: revisionEnvelope(ALPHA, alpha, NODE_Q) }),
          pub("publishRevision", { operation_id: "op-x", content: revisionEnvelope(ALPHA, alpha, NODE_X) }),
          pub("publishRevision", { operation_id: "op-y", content: revisionEnvelope(ALPHA, alpha, NODE_Y) }),
          pub("publishRevision", { operation_id: "op-w", content: revisionEnvelope(ALPHA, alpha, NODE_W) }),
          // Q is retired outright.
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: NODE_Q,
            expected_revision_id: REV_Q1,
            reason: "make Q terminal (retired)",
            peer_name: null,
            operation_id: "op-retire-q",
          }),
          // Y is made terminal by being SUPERSEDED (by W), not retired.
          ctx("supersedeNode", {
            workspace_name: ALPHA,
            node_id: NODE_Y,
            expected_revision_id: REV_Y1,
            new_node_id: NODE_W,
            new_revision_id: REV_W1,
            reason: "make Y terminal (superseded)",
            peer_name: null,
            operation_id: "op-supersede-y",
          }),
          // P -> Q: refused, Q is already retired.
          ctx("supersedeNode", {
            workspace_name: ALPHA,
            node_id: NODE_P,
            expected_revision_id: REV_P1,
            new_node_id: NODE_Q,
            new_revision_id: REV_Q1,
            reason: "refused: Q already terminal",
            peer_name: null,
            operation_id: "op-supersede-into-retired",
          }),
          // X -> Y: refused, Y is already superseded (by W).
          ctx("supersedeNode", {
            workspace_name: ALPHA,
            node_id: NODE_X,
            expected_revision_id: REV_X1,
            new_node_id: NODE_Y,
            new_revision_id: REV_Y1,
            reason: "refused: Y already terminal",
            peer_name: null,
            operation_id: "op-supersede-into-superseded",
          }),
        ],
        [REV_P1, REV_Q1, REV_X1, REV_Y1, REV_W1],
      );

      expect(ok(parsed.op5, "retire Q").outcome).toBe("accepted");
      expect(ok(parsed.op6, "supersede Y->W").outcome).toBe("accepted");

      const intoRetired = ok(parsed.op7, "supersede P->Q");
      expect(intoRetired.outcome).toBe("conflict");
      expect(intoRetired.reason).toBe("successor_terminal");

      const intoSuperseded = ok(parsed.op8, "supersede X->Y");
      expect(intoSuperseded.outcome).toBe("conflict");
      expect(intoSuperseded.reason).toBe("successor_terminal");

      // Neither refusal wrote anything: P and X are both STILL eligible,
      // and Q/Y's own terminal events are unaffected by the refused calls.
      const followUp = await drive(
        fixture,
        [
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_P }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_X }),
        ],
        [],
      );
      expect(ok(followUp.op0, "P still eligible")).toMatchObject({ eligible: true });
      expect(ok(followUp.op1, "X still eligible")).toMatchObject({ eligible: true });
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});

describe("#29 slice B: search-chunk read paths never treat a terminal node as ordinary", () => {
  test("reconcileSearchChunks reports a retired node as ineligible, not missing; indexRevisionChunks refuses one outright", async () => {
    const NODE_LIVE = idOf("eligLive");
    const NODE_DEAD = idOf("eligDead");
    const REV_LIVE = idOf("eligLiveR");
    const REV_DEAD = idOf("eligDeadR");

    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-live", content: revisionEnvelope(ALPHA, alpha, NODE_LIVE) }),
          pub("publishRevision", { operation_id: "op-dead", content: revisionEnvelope(ALPHA, alpha, NODE_DEAD) }),
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: NODE_DEAD,
            expected_revision_id: REV_DEAD,
            reason: "search-chunk proof: retire DEAD",
            peer_name: null,
            operation_id: "op-retire-dead",
          }),
          ctx("reconcileSearchChunks", { workspace_name: ALPHA, limit: 10 }),
          ctx("indexRevisionChunks", {
            workspace_name: ALPHA,
            node_id: NODE_DEAD,
            revision_id: REV_DEAD,
            chunker_version: "chunker/v1",
            // #30 R7 (search-embed): the closed registry refuses any other
            // name before the lifecycle check is ever reached.
            embedding_profile: { name: activeEmbeddingProfileId(), dims: 384 },
          }),
        ],
        [REV_LIVE, REV_DEAD],
      );
      expect(ok(parsed.op0, "publish live").outcome).toBe("accepted");
      expect(ok(parsed.op1, "publish dead").outcome).toBe("accepted");
      expect(ok(parsed.op2, "retire dead").outcome).toBe("accepted");

      const reconciled = ok(parsed.op3, "reconcileSearchChunks");
      expect(reconciled.visited).toBe(2);
      expect(reconciled.ineligible).toBe(1);
      // The retired node's absent chunks are not a gap: never in
      // `missing_revisions`, never counted in `missing` -- only the LIVE
      // node (never indexed in this test) is a real, reportable gap.
      const missingIds = reconciled.missing_revisions.map((m: any) => m.node_id);
      expect(missingIds).not.toContain(NODE_DEAD);
      expect(missingIds).toContain(NODE_LIVE);
      expect(reconciled.missing).toBe(1);

      const indexed = ok(parsed.op4, "indexRevisionChunks on retired node");
      expect(indexed.outcome).toBe("ineligible");
      expect(indexed.reason).toBe("retired");
    } finally {
      await fixture.cleanup();
    }
  }, 180_000);
});
