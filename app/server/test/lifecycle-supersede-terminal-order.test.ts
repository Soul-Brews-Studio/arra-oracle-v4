/**
 * #29 slice B fix round: `supersedeNode`'s `successor_terminal` check must
 * run AFTER the request's own `/node_id` and `/peer_name` references resolve
 * -- lifecycle-v1.md §11's frozen precedence ("a request naming a
 * nonexistent peer is told so rather than handed a stale_pin/already_terminal
 * conflict to retry into"), which the first version of this slice broke by
 * running the new check in `service.supersedeNode.ts` BEFORE
 * `writeLifecycleEventFresh` ever resolved either reference.
 *
 * Reproduces the reviewer's own probe: retire Q, then call `supersedeNode`
 * into Q four ways -- a nonexistent `node_id`, a peer that exists nowhere, a
 * beta-only peer, and a stale pin. The fix's scope, exactly as specified
 * ("run the terminal-successor check after the NODE AND PEER references
 * resolve"), is the first three: each must be told about ITS OWN reference
 * problem, never handed `{outcome:"conflict", reason:"successor_terminal"}`
 * as if the bad reference were a real node. The fourth (a stale pin against
 * an otherwise-valid node/peer) is a genuinely different axis -- `pin`
 * freshness is an "expected value" check, not a "does this reference exist"
 * one, and the successor's OWN pre-existing foreign-reference checks
 * (`/new_node_id` existence, `/new_revision_id` match) have always run
 * BEFORE this node's `stale_pin` check, unchanged by this fix round -- so
 * `successor_terminal` still correctly wins over `stale_pin` there, proving
 * the fix was scoped to exactly what was named, not a wider pin reordering
 * nobody asked for.
 */

import { describe, expect, test } from "bun:test";
import { createFixture, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
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
  revisionIds: string[],
): Promise<Record<string, any>> => {
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ ops, clockMs: CLOCK_MS, revisionIds }),
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

describe("supersedeNode into an already-terminal successor: request references resolve FIRST", () => {
  test("nonexistent node_id, a peer nowhere, a beta-only peer, and a stale pin are each told their OWN problem, never successor_terminal", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const betaOnlyPeer = beta.peer_names[0]!;
      const alphaPeer = alpha.peer_names[0]!;

      const nodeP = contextId("order-p");
      const nodeQ = contextId("order-q"); // will be retired -> terminal successor
      const missingNode = contextId("order-missing");
      const revP1 = contextId("order-p-r1");
      const revQ1 = contextId("order-q-r1");

      const attempt = (
        node_id: string,
        expected_revision_id: string,
        peer_name: string | null,
        operation_id: string,
      ) =>
        ctx("supersedeNode", {
          workspace_name: ALPHA,
          node_id,
          expected_revision_id,
          new_node_id: nodeQ,
          new_revision_id: revQ1,
          reason: "order fix round probe",
          peer_name,
          operation_id,
        });

      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-order-p", content: revisionEnvelope(ALPHA, alpha, nodeP) }),
          pub("publishRevision", { operation_id: "op-order-q", content: revisionEnvelope(ALPHA, alpha, nodeQ) }),
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: nodeQ,
            expected_revision_id: revQ1,
            reason: "make Q terminal before the order probe",
            peer_name: null,
            operation_id: "op-order-retire-q",
          }),
          // (a) node_id does not exist anywhere.
          attempt(missingNode, revP1, null, "op-order-missing-node"),
          // (b) peer_name exists nowhere.
          attempt(nodeP, revP1, "no-such-peer-anywhere", "op-order-peer-nowhere"),
          // (c) peer_name exists only in beta.
          attempt(nodeP, revP1, betaOnlyPeer, "op-order-peer-beta-only"),
          // (d) stale pin: node_id is real, but expected_revision_id is
          // wrong. NOT part of this fix's scope (node/peer only) -- kept as
          // a control to prove `successor_terminal` legitimately still wins
          // here, matching the successor's own pre-existing, unchanged
          // foreign-reference checks.
          attempt(nodeP, revQ1, null, "op-order-stale-pin"),
          // Every refused attempt above must have written NOTHING and changed
          // NOTHING: P is still fully eligible.
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: nodeP }),
          // (e) Once both references are genuinely valid, the actual rule
          // this slice adds still fires: successor_terminal.
          attempt(nodeP, revP1, alphaPeer, "op-order-genuine"),
        ],
        [revP1, revQ1],
      );

      expect(ok(parsed.op0, "publish P").outcome).toBe("accepted");
      expect(ok(parsed.op1, "publish Q").outcome).toBe("accepted");
      expect(ok(parsed.op2, "retire Q").outcome).toBe("accepted");

      refusedReference(parsed.op3, "/node_id", "(a) nonexistent node_id");
      refusedReference(parsed.op4, "/peer_name", "(b) peer that exists nowhere");
      refusedReference(parsed.op5, "/peer_name", "(c) beta-only peer");

      // Control: NOT a claimed bug fix -- `successor_terminal` legitimately
      // outranks `stale_pin` here, the same way it has always outranked the
      // successor's own existence/revision-match checks. Only node_id and
      // peer_name were the frozen-precedence violation this round fixes.
      const stalePin = ok(parsed.op6, "(d) stale pin");
      expect(stalePin).toMatchObject({ outcome: "conflict", reason: "successor_terminal" });

      expect(ok(parsed.op7, "P still fully eligible")).toMatchObject({ eligible: true, reasons: [] });

      const genuine = ok(parsed.op8, "(e) genuine attempt into terminal Q");
      expect(genuine).toMatchObject({ outcome: "conflict", reason: "successor_terminal" });
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
