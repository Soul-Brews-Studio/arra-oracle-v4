/**
 * #28 Unit B -- mixed continues/forked_from cycle refusal.
 *
 * `assertSessionLinkAcyclic` walks BOTH directed relations at every step,
 * regardless of the proposed edge's own relation, so a cycle built by mixing
 * `continues` and `forked_from` is caught; `related_to` stays fully exempt
 * (session-link-v1.md Decision 4's 2026-09-26 amendment, DECISIONS.md R7).
 *
 * Split out of `session-link-service.test.ts` (the 500-line cap): the
 * `describe` block and its local `drive`/`ctx`/`seedOps` helpers below are
 * that file's own tests, copied verbatim, not a shared import -- matching
 * every other split `session-link-*.test.ts` file in this directory.
 *
 * The last three cases (reverse continues onto a stored forked_from edge, a
 * same-relation forked_from reverse, and a 3-node cross-relation loop) close
 * the mutation-testing gap an independent review found: mutating
 * `DIRECTED_SESSION_RELATIONS` to `["continues"]` survived the suite above
 * because the only mixed-cycle case ran in one direction (stored `continues`,
 * proposed `forked_from`). These four cover the shapes that mutation missed.
 */

import { describe, expect, test } from "bun:test";
import { runGated } from "./helpers/publication-fixture";
import { peerRequest, sessionRequest } from "./helpers/context-fixture";
import {
  createSessionLinkFixture,
  createSessionLinkRequest,
  sessionLinkId,
} from "./helpers/session-link-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

describe("real persistence: mixed-relation cycle refusal (#28 Unit B)", () => {
  const CHILD = new URL("./fixtures/session-link-v1/core/gated-session-link.ts", import.meta.url).pathname;
  const ALPHA = "alpha-workspace";
  const CLOCK = Date.parse("2026-09-21T00:00:00.000Z");

  const drive = async (
    root: string,
    ops: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> => {
    const result = await runGated(root, CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK, ...extra })]);
    if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
    return JSON.parse(line);
  };
  const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });

  /** Peer and two sessions, through the REAL API. */
  const seedOps = () => [
    ctx("registerPeer", peerRequest(ALPHA)),
    ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessA"), name: "sess-a" })),
    ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessB"), name: "sess-b" })),
  ];
  const SEED = 3;

  const expectCycleRefused = (result: Record<string, any>) => {
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      name: "PublicationError",
      version: "arra-publication-error/v1",
      code: "invalid_request",
      path: "/to_session_name",
    });
  };

  test("a mixed continues/forked_from loop is refused at the request that closes it", async () => {
    // Amendment 2026-09-26 (overnight R7 (#28 part), Unit B): the cycle walk
    // now follows BOTH directed relations, not only the one named on the
    // proposed edge. sess-a --continues--> sess-b already exists (created by
    // op${SEED}); a request for sess-b --forked_from--> sess-a closes a
    // two-node loop that crosses relations. Before this fix the walk queried
    // `relation = 'forked_from'` only, never saw the stored `continues` edge,
    // and returned "created" (measured in .tmp/understand/issue-28 run2:
    // "oob_cross_relation_cycle: returned created").
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA)),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkBA"), from_session_name: "sess-b", to_session_name: "sess-a",
          relation: "forked_from",
        })),
      ]);
      const created = parsed[`op${SEED}`];
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.value.outcome).toBe("created");

      expectCycleRefused(parsed[`op${SEED + 1}`]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a legal diamond across continues AND forked_from stays accepted", async () => {
    // X --continues--> Y --continues--> W, and X --forked_from--> Z
    // --forked_from--> W: W is reached twice via two DIFFERENT relations.
    // This is a legitimate reconvergence (a diamond), not a cycle, and must
    // stay accepted now that the walk unions both relations.
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ctx("registerPeer", peerRequest(ALPHA)),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessX"), name: "sess-x" })),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessY"), name: "sess-y" })),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessZ"), name: "sess-z" })),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessW"), name: "sess-w" })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkYW"), from_session_name: "sess-y", to_session_name: "sess-w",
          relation: "continues",
        })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkXY"), from_session_name: "sess-x", to_session_name: "sess-y",
          relation: "continues",
        })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkZW"), from_session_name: "sess-z", to_session_name: "sess-w",
          relation: "forked_from",
        })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkXZ"), from_session_name: "sess-x", to_session_name: "sess-z",
          relation: "forked_from",
        })),
      ]);

      for (let i = 5; i <= 8; i += 1) {
        const result = parsed[`op${i}`];
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.value.outcome).toBe("created");
      }
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("related_to stays exempt from the cycle walk even facing a directed loop", async () => {
    // sess-a --continues--> sess-b exists; the reverse edge sess-b
    // --related_to--> sess-a is a DIFFERENT, symmetric relation and must not
    // be refused -- `related_to` never traverses, never bounds, never
    // enforces a cycle policy, per Decision 4 (unchanged by this amendment).
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA)),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkBAr"), from_session_name: "sess-b", to_session_name: "sess-a",
          relation: "related_to",
        })),
      ]);
      const created = parsed[`op${SEED}`];
      expect(created.ok, JSON.stringify(created)).toBe(true);

      const relatedReverse = parsed[`op${SEED + 1}`];
      expect(relatedReverse.ok, JSON.stringify(relatedReverse)).toBe(true);
      expect(relatedReverse.value.outcome).toBe("created");
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a stored forked_from edge closes a loop against a reverse continues request", async () => {
    // The mirror image of the first case above: sess-a --forked_from-->
    // sess-b is stored first, and the reverse sess-b --continues--> sess-a is
    // requested. A mutation that dropped `forked_from` from the walk (rather
    // than `continues`) would miss this direction while still passing the
    // first case, which is exactly the gap an independent review measured.
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkAB2"), from_session_name: "sess-a", to_session_name: "sess-b",
          relation: "forked_from",
        })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkBA2"), from_session_name: "sess-b", to_session_name: "sess-a",
          relation: "continues",
        })),
      ]);
      const created = parsed[`op${SEED}`];
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.value.outcome).toBe("created");

      expectCycleRefused(parsed[`op${SEED + 1}`]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a same-relation forked_from reverse edge is still refused", async () => {
    // Same-relation control: sess-a --forked_from--> sess-b stored, then
    // sess-b --forked_from--> sess-a requested. This never depended on the
    // cross-relation union, but it is the one shape absent from every
    // existing `forked_from` case in this file, so it stays pinned here.
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkAB3"), from_session_name: "sess-a", to_session_name: "sess-b",
          relation: "forked_from",
        })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkBA3"), from_session_name: "sess-b", to_session_name: "sess-a",
          relation: "forked_from",
        })),
      ]);
      const created = parsed[`op${SEED}`];
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.value.outcome).toBe("created");

      expectCycleRefused(parsed[`op${SEED + 1}`]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));

  test("a 3-node loop closed across continues and forked_from is refused", async () => {
    // a --continues--> b, b --forked_from--> c, then c --continues--> a
    // closes a three-node loop that crosses relations twice. A walk bound to
    // either single relation would never traverse both stored edges to find
    // the back edge; only the union of both relations at every step catches
    // it, and it must be caught at the THIRD request, not the second.
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessC2"), name: "sess-c2" })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkAB4"), from_session_name: "sess-a", to_session_name: "sess-b",
          relation: "continues",
        })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkBC4"), from_session_name: "sess-b", to_session_name: "sess-c2",
          relation: "forked_from",
        })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkCA4"), from_session_name: "sess-c2", to_session_name: "sess-a",
          relation: "continues",
        })),
      ]);
      const first = parsed[`op${SEED + 1}`];
      expect(first.ok, JSON.stringify(first)).toBe(true);
      expect(first.value.outcome).toBe("created");

      const second = parsed[`op${SEED + 2}`];
      expect(second.ok, JSON.stringify(second)).toBe(true);
      expect(second.value.outcome).toBe("created");

      expectCycleRefused(parsed[`op${SEED + 3}`]);
    } finally {
      await fixture.cleanup();
    }
  }, testTimeout(300_000));
});
