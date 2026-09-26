/**
 * #29 slice B (overnight R7): centralized normal-read eligibility.
 *
 * Written failing-first against `f919369`/`aff9c65`, before
 * `service.evaluateEligibility.ts` existed: `getRecallEligibility` had no
 * `reasons` field, `listNodes` returned a retired/superseded node with no
 * label and no default filter, `getAcceptedHead`/`listAcceptedHistory`
 * carried no `lifecycle` field, `supersedeNode` accepted a terminal
 * successor, and `reconcileSearchChunks`/`indexRevisionChunks` treated a
 * terminal node like any other. See `.tmp/understand/analysis-29.json`
 * (fix plan B, tests 2(a)-(j)) and `docs/overnight/DECISIONS.md` R7.
 *
 * Every dataset is a fresh `mktemp -d` via `createFixture`; writes run
 * inside the real writer gate through `gated-lifecycle.ts`, the same child
 * `lifecycle-service.test.ts` uses. Reads that need a controlled `as_of`
 * (the validity-window tests) go through a direct, in-process
 * `openContextReader` against the SAME on-disk dataset the gated writer
 * already flushed to -- `getRecallEligibility`'s `requestTimeMs` parameter
 * is exactly the seam `knowledge/registry.ts` uses in production (real
 * `Date.now()`), and passing a fixed number here is what keeps the window
 * tests deterministic instead of racing the wall clock.
 */

import { describe, expect, test } from "bun:test";
import {
  createFixture,
  encodeRequest,
  revisionEnvelope,
  runGated,
  type Fixture,
} from "./helpers/publication-fixture";
import { activeEmbeddingProfileId } from "../src/publication/search-chunk";
import { openContextReader } from "../src/publication/service";
import { testTimeout } from "./helpers/timing.testTimeout";

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

const listNodesReq = (overrides: Record<string, unknown> = {}) => ({
  workspace_name: ALPHA,
  after_id: null,
  limit: 100,
  include_total: true,
  type_term: null,
  include_inactive: false,
  ...overrides,
});

describe("#29 slice B: listNodes default excludes retired and superseded nodes", () => {
  test("retired excluded by default, present + labelled with include_inactive; superseded same, successor present; total counts the filtered set", async () => {
    const NODE_A = idOf("eligNodeA");
    const NODE_B = idOf("eligNodeB");
    const NODE_C = idOf("eligNodeC");
    const NODE_D = idOf("eligNodeD"); // supersedes B
    const REV_A1 = idOf("eligRevA1");
    const REV_B1 = idOf("eligRevB1");
    const REV_C1 = idOf("eligRevC1");
    const REV_D1 = idOf("eligRevD1");

    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-a", content: revisionEnvelope(ALPHA, alpha, NODE_A) }),
          pub("publishRevision", { operation_id: "op-b", content: revisionEnvelope(ALPHA, alpha, NODE_B) }),
          pub("publishRevision", { operation_id: "op-c", content: revisionEnvelope(ALPHA, alpha, NODE_C) }),
          pub("publishRevision", { operation_id: "op-d", content: revisionEnvelope(ALPHA, alpha, NODE_D) }),
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: NODE_A,
            expected_revision_id: REV_A1,
            reason: "slice B: retire A",
            peer_name: null,
            operation_id: "op-retire-a",
          }),
          ctx("supersedeNode", {
            workspace_name: ALPHA,
            node_id: NODE_B,
            expected_revision_id: REV_B1,
            new_node_id: NODE_D,
            new_revision_id: REV_D1,
            reason: "slice B: supersede B with D",
            peer_name: null,
            operation_id: "op-supersede-b",
          }),
          pub("listNodes", listNodesReq()),
          pub("listNodes", listNodesReq({ include_inactive: true })),
          pub("getAcceptedHead", { workspace_name: ALPHA, node_id: NODE_A }),
          pub("getAcceptedHead", { workspace_name: ALPHA, node_id: NODE_B }),
          pub("getAcceptedHead", { workspace_name: ALPHA, node_id: NODE_C }),
          pub("listAcceptedHistory", { workspace_name: ALPHA, node_id: NODE_A }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_A }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_B }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: NODE_C }),
        ],
        [REV_A1, REV_B1, REV_C1, REV_D1],
      );

      expect(ok(parsed.op0, "publish A").outcome).toBe("accepted");
      expect(ok(parsed.op1, "publish B").outcome).toBe("accepted");
      expect(ok(parsed.op2, "publish C").outcome).toBe("accepted");
      expect(ok(parsed.op3, "publish D").outcome).toBe("accepted");
      expect(ok(parsed.op4, "retire A").outcome).toBe("accepted");
      expect(ok(parsed.op5, "supersede B->D").outcome).toBe("accepted");

      // Current mode (default): A and B are gone; C and D remain, both
      // "active"; total is the FILTERED count, 2 -- not the native 4.
      const current = ok(parsed.op6, "listNodes current");
      const currentIds = current.rows.map((r: any) => r.id);
      expect(currentIds).not.toContain(NODE_A);
      expect(currentIds).not.toContain(NODE_B);
      expect(currentIds).toContain(NODE_C);
      expect(currentIds).toContain(NODE_D);
      for (const row of current.rows) {
        expect(row.lifecycle_state).toBe("active");
        expect(row.new_id).toBeNull();
      }
      expect(current.total).toBe("2");

      // History mode: everything is present, retired/superseded LABELLED.
      const history = ok(parsed.op7, "listNodes history");
      const byId = new Map<string, any>(history.rows.map((r: any) => [r.id, r]));
      expect(byId.get(NODE_A)?.lifecycle_state).toBe("retired");
      expect(byId.get(NODE_A)?.new_id).toBeNull();
      expect(byId.get(NODE_B)?.lifecycle_state).toBe("superseded");
      expect(byId.get(NODE_B)?.new_id).toBe(NODE_D);
      expect(byId.get(NODE_C)?.lifecycle_state).toBe("active");
      expect(byId.get(NODE_D)?.lifecycle_state).toBe("active");
      expect(history.total).toBe("4");

      // getAcceptedHead / listAcceptedHistory: additive `lifecycle` label,
      // node stays readable (AC2's "history accessible and clearly labelled").
      const headA = ok(parsed.op8, "getAcceptedHead A");
      expect(headA.lifecycle?.kind).toBe("retired");
      expect(headA.lifecycle?.event_id).toBe("1");
      expect(headA.lifecycle?.new_id).toBeNull();

      const headB = ok(parsed.op9, "getAcceptedHead B");
      expect(headB.lifecycle?.kind).toBe("superseded");
      expect(headB.lifecycle?.new_id).toBe(NODE_D);
      expect(headB.lifecycle?.event_id).toBe("2");

      const headC = ok(parsed.op10, "getAcceptedHead C");
      expect(headC.lifecycle).toBeNull();

      const historyA = ok(parsed.op11, "listAcceptedHistory A");
      expect(historyA.lifecycle?.kind).toBe("retired");

      // getRecallEligibility: reasons carries the SAME classification.
      expect(ok(parsed.op12, "eligibility A")).toMatchObject({ eligible: false, reasons: ["retired"] });
      expect(ok(parsed.op13, "eligibility B")).toMatchObject({ eligible: false, reasons: ["superseded"] });
      expect(ok(parsed.op14, "eligibility C")).toMatchObject({ eligible: true, reasons: [] });
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(180_000));
});

describe("#29 fix round: include_inactive is OPTIONAL on the wire, default false", () => {
  test("a listNodes request that OMITS include_inactive entirely still excludes a retired node -- the exact shape the daily-loop `nodes list` CLI alias sends without --history", async () => {
    const NODE_E = idOf("eligNodeE");
    const NODE_F = idOf("eligNodeF");
    const REV_E1 = idOf("eligRevE1");
    const REV_F1 = idOf("eligRevF1");

    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-e", content: revisionEnvelope(ALPHA, alpha, NODE_E) }),
          pub("publishRevision", { operation_id: "op-f", content: revisionEnvelope(ALPHA, alpha, NODE_F) }),
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: NODE_E,
            expected_revision_id: REV_E1,
            reason: "fix round: retire E, then list with include_inactive omitted",
            peer_name: null,
            operation_id: "op-retire-e",
          }),
          // No `include_inactive` key at all -- a required-closed key would
          // fail this `invalid_request`. It must behave exactly like an
          // explicit `include_inactive: false`.
          pub("listNodes", {
            workspace_name: ALPHA,
            after_id: null,
            limit: 100,
            include_total: true,
            type_term: null,
          }),
        ],
        [REV_E1, REV_F1],
      );

      expect(ok(parsed.op0, "publish E").outcome).toBe("accepted");
      expect(ok(parsed.op1, "publish F").outcome).toBe("accepted");
      expect(ok(parsed.op2, "retire E").outcome).toBe("accepted");

      const page = ok(parsed.op3, "listNodes with include_inactive omitted");
      const ids = page.rows.map((r: any) => r.id);
      expect(ids).not.toContain(NODE_E);
      expect(ids).toContain(NODE_F);
      expect(page.total).toBe("1");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(180_000));
});

describe("#29 slice B: listNodes total matches the filtered set across pages", () => {
  test("a small page size still reports the TRUE filtered total, not the native unfiltered one", async () => {
    const nodes = ["totalP", "totalQ", "totalR", "totalS", "totalT"].map((s) => idOf(`elig${s}`));
    const revs = ["totalP1", "totalQ1", "totalR1", "totalS1", "totalT1"].map((s) => idOf(`elig${s}`));

    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const publishOps = nodes.map((n, i) =>
        pub("publishRevision", { operation_id: `op-total-${i}`, content: revisionEnvelope(ALPHA, alpha, n) }),
      );
      const parsed = await drive(
        fixture,
        [
          ...publishOps,
          // Retire P, supersede Q -> R (R already published above).
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: nodes[0]!,
            expected_revision_id: revs[0]!,
            reason: "total proof: retire P",
            peer_name: null,
            operation_id: "op-total-retire",
          }),
          ctx("supersedeNode", {
            workspace_name: ALPHA,
            node_id: nodes[1]!,
            expected_revision_id: revs[1]!,
            new_node_id: nodes[2]!,
            new_revision_id: revs[2]!,
            reason: "total proof: supersede Q->R",
            peer_name: null,
            operation_id: "op-total-supersede",
          }),
          // limit:1 forces multiple pages -- `total` must still equal 3
          // (S, T, R remain; P and Q are the two terminal nodes).
          pub("listNodes", listNodesReq({ limit: 1 })),
        ],
        revs,
      );
      for (const [i] of nodes.entries()) expect(ok(parsed[`op${i}`], `publish ${i}`).outcome).toBe("accepted");
      expect(ok(parsed.op5, "retire").outcome).toBe("accepted");
      expect(ok(parsed.op6, "supersede").outcome).toBe("accepted");

      const firstPage = ok(parsed.op7, "listNodes page 1");
      expect(firstPage.rows.length).toBe(1);
      expect(firstPage.total).toBe("3");

      // Walk every remaining page with the SAME filter and confirm the
      // filtered set really does have exactly 3 rows -- `total` is not just
      // internally consistent, it matches what a full walk actually finds.
      const reader = await openContextReader(fixture.datasetRoot);
      const seen = new Set<string>(firstPage.rows.map((r: any) => r.id));
      let after = firstPage.next_after_id;
      let guard = 0;
      while (after !== null && guard < 100) {
        guard += 1;
        const page = (await reader.publication.listNodes(
          encodeRequest(listNodesReq({ after_id: after, limit: 1, include_total: false })),
        )) as { rows: Record<string, unknown>[]; next_after_id: string | null };
        for (const row of page.rows) seen.add(row.id as string);
        after = page.next_after_id;
      }
      expect(seen.size).toBe(3);
      expect(seen.has(nodes[0]!)).toBe(false); // P: retired
      expect(seen.has(nodes[1]!)).toBe(false); // Q: superseded
      expect(seen.has(nodes[2]!)).toBe(true); // R: Q's successor
      expect(seen.has(nodes[3]!)).toBe(true); // S
      expect(seen.has(nodes[4]!)).toBe(true); // T
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(180_000));
});

describe("#29 slice B: the validity window (is_active, valid_from, valid_to) at a controlled as_of", () => {
  test("inactive, not-yet-valid and expired heads are ineligible with the right reasons; a valid window is eligible", async () => {
    const NODE_INACTIVE = idOf("eligInactive");
    const NODE_FUTURE = idOf("eligFuture");
    const NODE_PAST = idOf("eligPast");
    const REV_INACTIVE = idOf("eligInactiveR");
    const REV_FUTURE = idOf("eligFutureR");
    const REV_PAST = idOf("eligPastR");

    const validFrom = "2027-01-01T00:00:00.000Z";
    const validTo = "2020-01-01T00:00:00.000Z";
    const beforeValidFrom = Date.parse("2026-01-01T00:00:00.000Z");
    const afterValidFrom = Date.parse("2027-06-01T00:00:00.000Z");
    const beforeValidTo = Date.parse("2019-01-01T00:00:00.000Z");
    const afterValidTo = Date.parse("2021-01-01T00:00:00.000Z");

    const fixture = await createFixture([ALPHA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", {
            operation_id: "op-inactive",
            content: revisionEnvelope(ALPHA, alpha, NODE_INACTIVE, { is_active: false }),
          }),
          pub("publishRevision", {
            operation_id: "op-future",
            content: revisionEnvelope(ALPHA, alpha, NODE_FUTURE, { valid_from: validFrom }),
          }),
          pub("publishRevision", {
            operation_id: "op-past",
            content: revisionEnvelope(ALPHA, alpha, NODE_PAST, { valid_to: validTo }),
          }),
        ],
        [REV_INACTIVE, REV_FUTURE, REV_PAST],
      );
      expect(ok(parsed.op0, "publish inactive").outcome).toBe("accepted");
      expect(ok(parsed.op1, "publish future").outcome).toBe("accepted");
      expect(ok(parsed.op2, "publish past").outcome).toBe("accepted");

      const reader = await openContextReader(fixture.datasetRoot);
      const eligibility = async (nodeId: string, asOf: number) =>
        reader.context.getRecallEligibility(
          encodeRequest({ workspace_name: ALPHA, node_id: nodeId }),
          asOf,
        ) as Promise<{ eligible: boolean; reasons: string[] }>;

      const inactive = await eligibility(NODE_INACTIVE, CLOCK_MS);
      expect(inactive.eligible).toBe(false);
      expect(inactive.reasons).toContain("inactive");

      const beforeWindow = await eligibility(NODE_FUTURE, beforeValidFrom);
      expect(beforeWindow.eligible).toBe(false);
      expect(beforeWindow.reasons).toContain("not_yet_valid");

      const afterWindowOpens = await eligibility(NODE_FUTURE, afterValidFrom);
      expect(afterWindowOpens.eligible).toBe(true);
      expect(afterWindowOpens.reasons).toEqual([]);

      const beforeExpiry = await eligibility(NODE_PAST, beforeValidTo);
      expect(beforeExpiry.eligible).toBe(true);
      expect(beforeExpiry.reasons).toEqual([]);

      const afterExpiry = await eligibility(NODE_PAST, afterValidTo);
      expect(afterExpiry.eligible).toBe(false);
      expect(afterExpiry.reasons).toContain("expired");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(180_000));
});

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
  }, testTimeout(180_000));
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
  }, testTimeout(180_000));
});
