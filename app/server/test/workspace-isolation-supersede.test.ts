/**
 * #10 two-workspace isolation proof -- supersedeNode's OWN request path.
 *
 * `workspace-isolation.test.ts` proves retireNode's request path and uses it
 * to stand in for the shared writeLifecycleEvent/supersede_log machinery,
 * on the judgement that supersedeNode "shares the identical old_id-scoped
 * uniqueness and witness logic per the source". That judgement was made by
 * reading the source, not by running a test, and supersedeNode carries a
 * strictly LARGER request shape than retireNode: `new_id`/`new_revision_id`,
 * which retire leaves null. Those two extra reference fields are additional
 * surface retireNode's proof cannot possibly cover -- a successor reference
 * is another chance to resolve an id against the wrong workspace.
 *
 * This file closes exactly that gap: supersedeNode, colliding old_id AND
 * colliding new_id/new_revision_id across two workspaces, plus the specific
 * case retireNode structurally cannot exercise -- a successor that resolves
 * in beta but is requested from alpha.
 */

import { describe, expect, test } from "bun:test";
import {
  createFixture,
  revisionEnvelope,
  runGated,
  type Fixture,
} from "./helpers/publication-fixture";
import { contextId } from "./helpers/context-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const CHILD = new URL("./fixtures/isolation-v1/core/gated-isolation.ts", import.meta.url).pathname;
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const TEST_TIMEOUT_MS = testTimeout(300_000);

const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });

const drive = async (
  fixture: Fixture,
  ops: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>> => {
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ ops, clockMs: CLOCK_MS, ...extra }),
  ]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 900)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 900)}`);
  return JSON.parse(line);
};

const ok = (op: any, label: string) => {
  expect(op?.ok, `${label}: ${JSON.stringify(op)}`).toBe(true);
  return op.value;
};
const refusedReference = (op: any, path: string, label: string) => {
  expect(op?.ok, `${label} expected a refusal, got ${JSON.stringify(op)}`).toBe(false);
  expect(op.code, label).toBe("invalid_reference");
  expect(op.path, label).toBe(path);
};

describe("supersedeNode: colliding old_id AND colliding successor ids across workspaces", () => {
  test("identical old_id and identical successor node_id/revision_id in both workspaces: each supersede resolves its OWN successor, never the other's", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const oldNodeId = contextId("shared-super-old");
      const succNodeId = contextId("shared-super-succ");
      const revAlphaOld = contextId("rev-alpha-old-s");
      const revAlphaSucc = contextId("rev-alpha-succ-s");
      const revBetaOld = contextId("rev-beta-old-s");
      const revBetaSucc = contextId("rev-beta-succ-s");

      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-alpha-old-s", content: revisionEnvelope(ALPHA, alpha, oldNodeId, { title: "alpha old title" }) }),
          pub("publishRevision", { operation_id: "op-alpha-succ-s", content: revisionEnvelope(ALPHA, alpha, succNodeId, { title: "alpha successor title" }) }),
          pub("publishRevision", { operation_id: "op-beta-old-s", content: revisionEnvelope(BETA, beta, oldNodeId, { title: "beta old title" }) }),
          pub("publishRevision", { operation_id: "op-beta-succ-s", content: revisionEnvelope(BETA, beta, succNodeId, { title: "beta successor title" }) }),
          // Same operation_id in both workspaces, on top of every other
          // collision -- an unscoped classifyLifecycleReplay would see
          // alpha's row and call beta's attempt a replay.
          ctx("supersedeNode", {
            workspace_name: ALPHA, node_id: oldNodeId, expected_revision_id: revAlphaOld,
            new_node_id: succNodeId, new_revision_id: revAlphaSucc,
            reason: "alpha supersede", peer_name: null, operation_id: "shared-supersede-op",
          }),
          ctx("supersedeNode", {
            workspace_name: BETA, node_id: oldNodeId, expected_revision_id: revBetaOld,
            new_node_id: succNodeId, new_revision_id: revBetaSucc,
            reason: "beta supersede", peer_name: null, operation_id: "shared-supersede-op",
          }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: oldNodeId }),
          ctx("getRecallEligibility", { workspace_name: BETA, node_id: oldNodeId }),
          ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: oldNodeId, after_event_id: null, limit: 10 }),
          ctx("listLifecycleHistory", { workspace_name: BETA, node_id: oldNodeId, after_event_id: null, limit: 10 }),
        ],
        { revisionIds: [revAlphaOld, revAlphaSucc, revBetaOld, revBetaSucc] },
      );

      expect(ok(parsed.op4, "alpha supersede").outcome).toBe("accepted");
      expect(ok(parsed.op5, "beta supersede").outcome).toBe("accepted");
      expect(ok(parsed.op6, "alpha eligibility after").eligible).toBe(false);
      expect(ok(parsed.op7, "beta eligibility after").eligible).toBe(false);

      const alphaHistory = ok(parsed.op8, "alpha history");
      const betaHistory = ok(parsed.op9, "beta history");
      expect(alphaHistory.rows).toHaveLength(1);
      expect(betaHistory.rows).toHaveLength(1);
      // Each event carries its OWN successor -- the half-null rule holds
      // (both new_id/new_revision_id present, never one alone), and the
      // resolved new_title is each workspace's OWN successor revision, never
      // the other's, despite the identical successor node_id everywhere.
      expect(alphaHistory.rows[0].new_id).toBe(succNodeId);
      expect(alphaHistory.rows[0].new_revision_id).toBe(revAlphaSucc);
      expect(alphaHistory.rows[0].new_title).toBe("alpha successor title");
      expect(betaHistory.rows[0].new_id).toBe(succNodeId);
      expect(betaHistory.rows[0].new_revision_id).toBe(revBetaSucc);
      expect(betaHistory.rows[0].new_title).toBe("beta successor title");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a successor that resolves ONLY in beta is refused from alpha as invalid_reference, never silently accepted or resolved cross-workspace", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const oldNodeId = contextId("shared-super-old2");
      const revOld = contextId("rev-old2");
      // The successor node_id COLLIDES across workspaces, but its accepted
      // revision does not: alpha's own successor carries revAlphaSucc, beta's
      // identically-id'd successor carries a DIFFERENT revision entirely.
      const succNodeId = contextId("shared-super-succ2");
      const revAlphaSucc = contextId("rev-alpha-succ2");
      const revBetaSucc = contextId("rev-beta-succ2");
      // A second successor that exists ONLY in beta -- absent from alpha
      // altogether, the case retireNode has no field to even attempt.
      const betaOnlySuccId = contextId("beta-only-succ2");
      const revBetaOnlySucc = contextId("rev-beta-only-succ2");

      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-old2", content: revisionEnvelope(ALPHA, alpha, oldNodeId) }),
          pub("publishRevision", { operation_id: "op-alpha-succ2", content: revisionEnvelope(ALPHA, alpha, succNodeId) }),
          pub("publishRevision", { operation_id: "op-beta-succ2", content: revisionEnvelope(BETA, beta, succNodeId) }),
          pub("publishRevision", { operation_id: "op-beta-only-succ2", content: revisionEnvelope(BETA, beta, betaOnlySuccId) }),
          // Attempt 1: successor node_id exists in alpha too (collision), but
          // the REQUESTED revision_id is beta's, not alpha's. The node lookup
          // alone cannot catch this -- only the revision-id match can.
          ctx("supersedeNode", {
            workspace_name: ALPHA, node_id: oldNodeId, expected_revision_id: revOld,
            new_node_id: succNodeId, new_revision_id: revBetaSucc,
            reason: "alpha attempts beta's revision", peer_name: null,
            operation_id: "alpha-attempt-beta-revision",
          }),
          // Attempt 2: successor node_id does not exist in alpha at all.
          ctx("supersedeNode", {
            workspace_name: ALPHA, node_id: oldNodeId, expected_revision_id: revOld,
            new_node_id: betaOnlySuccId, new_revision_id: revBetaOnlySucc,
            reason: "alpha attempts beta-only node", peer_name: null,
            operation_id: "alpha-attempt-beta-only-node",
          }),
          // The node must still be untouched by either refused attempt: a
          // genuinely fresh supersede against alpha's OWN successor still
          // succeeds afterward.
          ctx("supersedeNode", {
            workspace_name: ALPHA, node_id: oldNodeId, expected_revision_id: revOld,
            new_node_id: succNodeId, new_revision_id: revAlphaSucc,
            reason: "alpha genuine supersede", peer_name: null,
            operation_id: "alpha-genuine-supersede",
          }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: oldNodeId }),
        ],
        { revisionIds: [revOld, revAlphaSucc, revBetaSucc, revBetaOnlySucc] },
      );

      expect(ok(parsed.op0, "old node publish").outcome).toBe("accepted");
      expect(ok(parsed.op1, "alpha successor publish").outcome).toBe("accepted");
      expect(ok(parsed.op2, "beta successor publish").outcome).toBe("accepted");
      expect(ok(parsed.op3, "beta-only successor publish").outcome).toBe("accepted");

      refusedReference(parsed.op4, "/new_revision_id", "alpha requesting beta's revision on a colliding successor id");
      refusedReference(parsed.op5, "/new_node_id", "alpha requesting a successor that exists only in beta");

      // Neither refusal consumed the node or the pin: the genuine attempt,
      // reusing the same expected_revision_id, still succeeds.
      expect(ok(parsed.op6, "alpha genuine supersede").outcome).toBe("accepted");
      expect(ok(parsed.op7, "alpha eligibility after").eligible).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a witness_event_id computed from a global row-id counter stays alpha's OWN row id under supersedeNode, even after beta churns MANY supersedeNode events", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const alphaOldId = contextId("witness-s-alpha-old");
      const alphaSuccId = contextId("witness-s-alpha-succ");
      const alphaOldRev = contextId("witness-s-alpha-old-r");
      const alphaSuccRev = contextId("witness-s-alpha-succ-r");
      const betaOldIds = Array.from({ length: 5 }, (_u, i) => contextId(`witness-s-b-old-${i}`));
      const betaSuccIds = Array.from({ length: 5 }, (_u, i) => contextId(`witness-s-b-succ-${i}`));
      const betaOldRevs = Array.from({ length: 5 }, (_u, i) => contextId(`witness-s-b-old-r-${i}`));
      const betaSuccRevs = Array.from({ length: 5 }, (_u, i) => contextId(`witness-s-b-succ-r-${i}`));

      const ops: Array<Record<string, unknown>> = [
        pub("publishRevision", { operation_id: "op-witness-s-alpha-old", content: revisionEnvelope(ALPHA, alpha, alphaOldId) }),
        pub("publishRevision", { operation_id: "op-witness-s-alpha-succ", content: revisionEnvelope(ALPHA, alpha, alphaSuccId) }),
      ];
      for (const [i, node] of betaOldIds.entries()) {
        ops.push(pub("publishRevision", { operation_id: `op-witness-s-beta-old-${i}`, content: revisionEnvelope(BETA, beta, node) }));
        ops.push(pub("publishRevision", { operation_id: `op-witness-s-beta-succ-${i}`, content: revisionEnvelope(BETA, beta, betaSuccIds[i]!) }));
      }
      // Alpha's single supersede FIRST, so its witness is captured before
      // beta writes many MORE supersede_log rows and pushes the table-wide
      // id counter well past alpha's own single row.
      ops.push(
        ctx("supersedeNode", {
          workspace_name: ALPHA, node_id: alphaOldId, expected_revision_id: alphaOldRev,
          new_node_id: alphaSuccId, new_revision_id: alphaSuccRev,
          reason: "alpha only", peer_name: null, operation_id: "op-super-retire-alpha",
        }),
      );
      for (const [i, node] of betaOldIds.entries()) {
        ops.push(
          ctx("supersedeNode", {
            workspace_name: BETA, node_id: node, expected_revision_id: betaOldRevs[i],
            new_node_id: betaSuccIds[i], new_revision_id: betaSuccRevs[i],
            reason: `beta ${i}`, peer_name: null, operation_id: `op-super-retire-beta-${i}`,
          }),
        );
      }
      ops.push(ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: alphaOldId }));

      const revisionIds = [
        alphaOldRev, alphaSuccRev,
        ...betaOldIds.flatMap((_id, i) => [betaOldRevs[i]!, betaSuccRevs[i]!]),
      ];
      const parsed = await drive(fixture, ops, { revisionIds });

      const alphaSupersedeIndex = 2 + betaOldIds.length * 2;
      const eligibilityIndex = alphaSupersedeIndex + 1 + betaOldIds.length;
      const alphaSupersede = ok(parsed[`op${alphaSupersedeIndex}`], "alpha supersede");
      expect(alphaSupersede.outcome).toBe("accepted");
      const finalEligibility = ok(parsed[`op${eligibilityIndex}`], "alpha eligibility after beta churn");
      expect(finalEligibility.eligible).toBe(false);
      // witness_event_id is scoped to alpha's OWN supersede_log rows: with a
      // single alpha event, this must equal that event's OWN physical id --
      // an unscoped MAX(id) over the whole table would instead surface one
      // of beta's ten LATER, larger row ids.
      expect(finalEligibility.witness_event_id).toBe(alphaSupersede.row.id);
      expect(finalEligibility.witness_event_id).not.toBe("0");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

// ── #10 analysis B: supersede_log.peer_name is a scoped reference ───────────

describe("supersede_log.peer_name resolves in the event's OWN workspace (lifecycle-v1 amendment 2026-09-26)", () => {
  test("a peer that exists only in beta, or nowhere, is invalid_reference at /peer_name from alpha and writes nothing; alpha's own peer and null are accepted", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const alphaPeer = alpha.peer_names[0]!;
      // Seeded in beta only: an unscoped peer lookup would accept it from alpha.
      const betaOnlyPeer = beta.peer_names[0]!;
      const oldId = contextId("peer-ref-old");
      const succId = contextId("peer-ref-succ");
      const retireId = contextId("peer-ref-retire");
      const nullId = contextId("peer-ref-null");
      const [revOld, revSucc, revRetire, revNull] = ["old", "succ", "retire", "null"].map((s) => contextId(`peer-ref-rev-${s}`));
      const supersede = (peer_name: string | null, operation_id: string) =>
        ctx("supersedeNode", {
          workspace_name: ALPHA, node_id: oldId, expected_revision_id: revOld,
          new_node_id: succId, new_revision_id: revSucc, reason: "peer reference", peer_name, operation_id,
        });
      const retire = (node_id: string, expected_revision_id: string, peer_name: string | null, operation_id: string) =>
        ctx("retireNode", { workspace_name: ALPHA, node_id, expected_revision_id, reason: "peer reference", peer_name, operation_id });
      const history = (node_id: string) =>
        ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id, after_event_id: null, limit: 10 });

      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-peer-old", content: revisionEnvelope(ALPHA, alpha, oldId) }),
          pub("publishRevision", { operation_id: "op-peer-succ", content: revisionEnvelope(ALPHA, alpha, succId) }),
          pub("publishRevision", { operation_id: "op-peer-retire", content: revisionEnvelope(ALPHA, alpha, retireId) }),
          pub("publishRevision", { operation_id: "op-peer-null", content: revisionEnvelope(ALPHA, alpha, nullId) }),
          ctx("getPeer", { workspace_name: ALPHA, peer_name: betaOnlyPeer }),
          supersede(betaOnlyPeer, "op-supersede-beta-peer"),
          retire(retireId, revRetire, "no-such-peer-anywhere", "op-retire-no-peer"),
          history(oldId),
          history(retireId),
          supersede(alphaPeer, "op-supersede-alpha-peer"),
          supersede(alphaPeer, "op-supersede-alpha-peer"),
          retire(nullId, revNull, null, "op-retire-null-peer"),
          // The refused retire consumed nothing: its operation_id is still free.
          retire(retireId, revRetire, alphaPeer, "op-retire-no-peer"),
        ],
        { revisionIds: [revOld, revSucc, revRetire, revNull] },
      );

      for (const op of ["op0", "op1", "op2", "op3"]) expect(ok(parsed[op], `publish ${op}`).outcome).toBe("accepted");
      // Precondition: the beta peer really is absent from alpha.
      expect(ok(parsed.op4, "alpha getPeer of the beta-only peer")).toBeNull();

      // FAILED before the amendment: both were accepted and written.
      refusedReference(parsed.op5, "/peer_name", "supersede naming a beta-only peer from alpha");
      refusedReference(parsed.op6, "/peer_name", "retire naming a peer that exists nowhere");
      expect(ok(parsed.op7, "history after refused supersede").rows).toEqual([]);
      expect(ok(parsed.op8, "history after refused retire").rows).toEqual([]);

      const accepted = ok(parsed.op9, "supersede with alpha's own peer");
      expect(accepted.outcome).toBe("accepted");
      expect(accepted.row.peer_name).toBe(alphaPeer);
      const replay = ok(parsed.op10, "exact replay");
      expect(replay.outcome).toBe("idempotent");
      expect(replay.row).toEqual(accepted.row);
      expect(ok(parsed.op11, "retire with a null peer").outcome).toBe("accepted");
      expect(ok(parsed.op12, "retire retried with a real peer").outcome).toBe("accepted");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
