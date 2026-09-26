/**
 * Session links v1 -- minimal smoke test.
 *
 * Not exhaustive by design: this proves the wired path actually works, and
 * proves the specific defects an independent review confirmed are actually
 * dead -- self-link vs. cycle-vs-caller-fault classification, the gray/black
 * DFS's diamond-vs-back-edge distinction, the wide-node refusal, the
 * evidence-ref codec integration, and the boundary/clock discipline for
 * replay/conflict/read. Ownership/recovery/precision coverage stays with
 * their own dispatched lanes.
 */

import { describe, expect, test } from "bun:test";
import { runGated } from "./helpers/publication-fixture";
import { peerRequest, sessionRequest } from "./helpers/context-fixture";
import {
  createSessionLinkFixture,
  createSessionLinkRequest,
  listSessionLinksRequest,
  sessionLinkId,
} from "./helpers/session-link-fixture";
import { ContractError } from "../src/contracts/errors";
import { PublicationError } from "../src/publication/errors";
import { parseCreateSessionLink, SESSION_RELATIONS } from "../src/publication/session-link";
import { canonicalize, obj } from "../src/contracts/jcs";
import { normalizeTarget } from "../src/contracts/evidence-v1";

describe("preflight: the required surface", () => {
  test("the pure module exists and exports its grammar", async () => {
    const mod = await import("../src/publication/session-link").catch((error) => ({
      __absent: String(error),
    }));
    expect(mod).not.toHaveProperty("__absent");
    expect(typeof (mod as Record<string, unknown>).parseCreateSessionLink).toBe("function");
    expect(typeof (mod as Record<string, unknown>).parseListSessionLinks).toBe("function");
    expect(typeof (mod as Record<string, unknown>).encodeSessionLinkRow).toBe("function");
    expect((mod as Record<string, unknown>).SESSION_RELATIONS).toEqual([
      "continues", "forked_from", "related_to",
    ]);
  });
});

describe("self-link is refused at PARSE time, for every relation", () => {
  // Byte-decidable from the two names alone: this must be a governed
  // ContractError, never a PublicationError, and never dependent on any
  // owner or workspace state -- proven here with NO gate and NO dataset at
  // all, which is the strongest possible evidence it happens outside the
  // queue.
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const req = (relation: string, overrides: Record<string, unknown> = {}) => ({
    id: sessionLinkId("linkX"),
    workspace_name: "alpha-workspace",
    from_session_name: "sess-a",
    to_session_name: "sess-a",
    relation,
    evidence_ref: null,
    created_by_peer_name: null,
    ...overrides,
  });

  for (const relation of SESSION_RELATIONS) {
    test(`relation "${relation}" self-link throws a governed ContractError at /to_session_name`, () => {
      let error: unknown;
      try {
        parseCreateSessionLink(bytes(req(relation)));
        throw new Error("expected a throw, got none");
      } catch (thrown) {
        error = thrown;
      }
      if (!(error instanceof ContractError)) throw error;
      expect(error.toJSON()).toEqual({
        version: "arra-error/v1", code: "invalid_value", path: "/to_session_name",
        message: "must not equal from_session_name",
      });
    });
  }

  test("the refusal fires regardless of workspace validity -- it never reaches a workspace lookup", () => {
    // `workspace_name` here names nothing real; if this test observes
    // anything OTHER than the same ContractError, self-link stopped being a
    // pure, owner-independent check.
    let error: unknown;
    try {
      parseCreateSessionLink(bytes(req("continues", { workspace_name: "does-not-exist-workspace" })));
      throw new Error("expected a throw, got none");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).path).toBe("/to_session_name");
  });
});

describe("real persistence: session links inside the real gate", () => {
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
  const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

  /** Peer and two sessions, through the REAL API. */
  const seedOps = () => [
    ctx("registerPeer", peerRequest(ALPHA)),
    ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessA"), name: "sess-a" })),
    ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessB"), name: "sess-b" })),
  ];
  const SEED = 3;

  test("create, read back both directions, replay, conflict, self-link and reverse-edge refusal", async () => {
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA)),
        ctx("listSessionLinks", listSessionLinksRequest(ALPHA, { session_name: "sess-a", direction: "from" })),
        ctx("listSessionLinks", listSessionLinksRequest(ALPHA, { session_name: "sess-b", direction: "to" })),
        // Exact replay: identical payload under the same id. NO clock, NO write.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA)),
        // Changed payload under the same id: a RETURNED conflict. NO clock, NO write.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, { relation: "related_to" })),
        // Self-link is refused by the PARSER now: it never even enters the
        // queue, so it must cost nothing here either.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("link2"), from_session_name: "sess-a", to_session_name: "sess-a",
        })),
        // A stored sess-a->sess-b edge already exists. Requesting the
        // REVERSE edge sess-b->sess-a would close a two-node cycle: the
        // caller's own request is at fault, not the dataset, so this is
        // invalid_request at /to_session_name -- NOT integrity_failure. This
        // DOES enter the queue (from != to), but fails before any clock
        // sample or write.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("link3"), from_session_name: "sess-b", to_session_name: "sess-a",
        })),
      ]);

      const created = parsed[`op${SEED}`];
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.value.outcome).toBe("created");
      expect(Object.keys(created.value.row)).toEqual([
        "id", "workspace_name", "from_session_name", "to_session_name",
        "relation", "evidence_ref", "created_by_peer_name", "created_at",
      ]);
      expect(created.value.row.from_session_name).toBe("sess-a");
      expect(created.value.row.to_session_name).toBe("sess-b");
      expect(created.value.row.relation).toBe("continues");
      expect(created.value.row.created_at).toBe("2026-09-21T00:00:00.000Z");

      const fromRead = parsed[`op${SEED + 1}`];
      expect(fromRead.ok, JSON.stringify(fromRead)).toBe(true);
      expect(fromRead.value.rows).toHaveLength(1);
      expect(fromRead.value.rows[0]).toEqual(created.value.row);
      expect(fromRead.value.next_cursor).toBeNull();

      const toRead = parsed[`op${SEED + 2}`];
      expect(toRead.ok, JSON.stringify(toRead)).toBe(true);
      expect(toRead.value.rows).toHaveLength(1);
      expect(toRead.value.rows[0]).toEqual(created.value.row);

      const replay = parsed[`op${SEED + 3}`];
      expect(replay.ok, JSON.stringify(replay)).toBe(true);
      expect(replay.value.outcome).toBe("already_satisfied");
      expect(replay.value.row).toEqual(created.value.row);

      const conflict = parsed[`op${SEED + 4}`];
      expect(conflict.ok, JSON.stringify(conflict)).toBe(true);
      expect(conflict.value.outcome).toBe("conflict");
      expect(conflict.value.row).toEqual(created.value.row);

      const selfLink = parsed[`op${SEED + 5}`];
      expect(selfLink.ok).toBe(false);
      expect(selfLink).toMatchObject({
        name: "ContractError",
        version: "arra-error/v1",
        code: "invalid_value",
        path: "/to_session_name",
      });

      const reverseEdge = parsed[`op${SEED + 6}`];
      expect(reverseEdge.ok).toBe(false);
      expect(reverseEdge).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "invalid_request",
        path: "/to_session_name",
      });

      // Exactly FOUR real mutations happened in this whole op list: the
      // three seed registrations and the one create. Two reads, a replay, a
      // conflict, a parse-time self-link refusal and a mid-queue cycle
      // refusal contribute NOTHING -- no clock sample, no boundary triple.
      expect(parsed.clockCalls).toBe(4);
      expect(parsed.trace).toHaveLength(12);
      for (let i = 0; i < parsed.trace.length; i += 3) {
        expect(parsed.trace.slice(i, i + 3)).toEqual(["before_write", "after_write", "after_readback"]);
      }
      // The LAST triple is the create under test, not a seed row.
      expect(parsed.trace.slice(-3)).toEqual(["before_write", "after_write", "after_readback"]);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a legal DAG diamond is accepted, not mistaken for a cycle", async () => {
    // X->Y, X->Z, Y->W, Z->W (all `continues`): W is reached twice, once via
    // Y and once via Z, which is an ordinary reconvergence, not a back edge.
    // An over-eager fix that raises integrity_failure on ANY revisit would
    // reject this legitimate diamond.
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ctx("registerPeer", peerRequest(ALPHA)),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessV"), name: "sess-v" })),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessX"), name: "sess-x" })),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessY"), name: "sess-y" })),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessZ"), name: "sess-z" })),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessW"), name: "sess-w" })),
        // Y->W first, so W is already BLACK (fully finished) by the time the
        // Z->W edge's walk reaches it via the second path.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkYW"), from_session_name: "sess-y", to_session_name: "sess-w",
        })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkXY"), from_session_name: "sess-x", to_session_name: "sess-y",
        })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkZW"), from_session_name: "sess-z", to_session_name: "sess-w",
        })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkXZ"), from_session_name: "sess-x", to_session_name: "sess-z",
        })),
        // NOW sess-x itself has TWO out-edges (to sess-y AND sess-z), both of
        // which reach sess-w. This create's OWN cycle walk starts at
        // sess-x and must traverse BOTH branches in the SAME call, hitting
        // sess-w a second time only after it is already BLACK -- the exact
        // revisit the gray/black DFS must treat as a legal reconvergence,
        // not a back edge.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkVX"), from_session_name: "sess-v", to_session_name: "sess-x",
        })),
      ]);

      for (let i = 6; i <= 10; i += 1) {
        const result = parsed[`op${i}`];
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.value.outcome).toBe("created");
      }
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

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

      const crossRelationLoop = parsed[`op${SEED + 1}`];
      expect(crossRelationLoop.ok).toBe(false);
      expect(crossRelationLoop).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "invalid_request",
        path: "/to_session_name",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

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
  }, 300_000);

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
  }, 300_000);

  test("a STORED back-edge cycle is caught as integrity_failure at root", async () => {
    // sess-b->sess-c and sess-c->sess-b (both `continues`) are planted
    // DIRECTLY, bypassing every service check -- a well-behaved writer could
    // never have produced this pair itself. A fresh request sess-a->sess-b
    // then walks FORWARD from sess-b, finds sess-c, finds sess-b again while
    // sess-b is still ON THE ACTIVE PATH: a genuine back edge.
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const micros = String(BigInt(CLOCK) * 1000n);
      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessC"), name: "sess-c" })),
        hx("insertRawSessionLinks", {
          rows: [
            {
              id: sessionLinkId("rawBC"), workspace_name: ALPHA, from_session_name: "sess-b",
              to_session_name: "sess-c", relation: "continues", evidence_ref: null,
              created_by_peer_name: null, created_at_micros: micros,
            },
            {
              id: sessionLinkId("rawCB"), workspace_name: ALPHA, from_session_name: "sess-c",
              to_session_name: "sess-b", relation: "continues", evidence_ref: null,
              created_by_peer_name: null, created_at_micros: micros,
            },
          ],
        }),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkAB"), from_session_name: "sess-a", to_session_name: "sess-b",
        })),
      ]);
      const planted = parsed[`op${SEED + 1}`];
      expect(planted.ok, JSON.stringify(planted)).toBe(true);

      const attempt = parsed[`op${SEED + 2}`];
      expect(attempt.ok).toBe(false);
      expect(attempt).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "integrity_failure",
        path: "",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a WIDE node refuses rather than silently walking an arbitrary subset", async () => {
    // sess-wide has more `continues` out-edges than the walk's bound. The
    // query that fetches them is UNORDERED, so a bare limit would return an
    // arbitrary subset and could silently miss the one edge that proves a
    // cycle. The fix refuses outright rather than ever acting on a partial
    // frontier.
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const micros = String(BigInt(CLOCK) * 1000n);
      const WIDE_COUNT = 1025; // MAX_CYCLE_VISITED (1024) + 1
      const wideRows = Array.from({ length: WIDE_COUNT }, (_, i) => ({
        id: `wide${String(i).padStart(17, "0")}`,
        workspace_name: ALPHA,
        from_session_name: "sess-wide",
        to_session_name: `wide-target-${i}`,
        relation: "continues",
        evidence_ref: null,
        created_by_peer_name: null,
        created_at_micros: micros,
      }));
      expect(wideRows[0]!.id).toHaveLength(21);

      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: sessionLinkId("sessWide"), name: "sess-wide" })),
        hx("insertRawSessionLinks", { rows: wideRows }),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkToWide"), from_session_name: "sess-a", to_session_name: "sess-wide",
        })),
      ]);
      const planted = parsed[`op${SEED + 1}`];
      expect(planted.ok, JSON.stringify(planted)).toBe(true);
      expect((planted.value as { inserted: number }).inserted).toBe(WIDE_COUNT);

      const attempt = parsed[`op${SEED + 2}`];
      expect(attempt.ok).toBe(false);
      expect(attempt).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "limit_exceeded",
        path: "",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a nonexistent workspace reports /workspace_name, not /to_session_name", async () => {
    // A PLAIN, non-self-link request (distinct endpoints) against a
    // workspace that was never registered. This proves reference resolution
    // still works exactly as before once the self-link check moved out of
    // the queue: the /workspace_name pointer is not shadowed or displaced by
    // anything related to that extraction.
    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ctx("createSessionLink", createSessionLinkRequest("nonexistent-workspace", {
          id: sessionLinkId("linkNW"),
        })),
      ]);
      const attempt = parsed.op0;
      expect(attempt.ok).toBe(false);
      expect(attempt).toMatchObject({
        name: "PublicationError",
        version: "arra-publication-error/v1",
        code: "invalid_reference",
        path: "/workspace_name",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);

  test("a non-null evidence_ref round-trips through the accepted target codec", async () => {
    const evidenceRef = { target_kind: "session" as const, target: { session_name: "sess-a" } };
    const expectedStoredText = canonicalize(
      obj({
        target_kind: "session",
        target: normalizeTarget("session", obj({ session_name: "sess-a" }), []),
      }),
      [],
    );

    const fixture = await createSessionLinkFixture([ALPHA]);
    try {
      const parsed = await drive(fixture.datasetRoot, [
        ...seedOps(),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkEvid"), evidence_ref: evidenceRef,
        })),
        // Identical evidence_ref: still an exact replay.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkEvid"), evidence_ref: evidenceRef,
        })),
        // A DIFFERENT evidence_ref under the same id: a returned conflict,
        // proving the replay comparison actually looks at this field.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: sessionLinkId("linkEvid"), evidence_ref: null,
        })),
      ]);

      const created = parsed[`op${SEED}`];
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.value.outcome).toBe("created");
      expect(created.value.row.evidence_ref).toBe(expectedStoredText);
      expect(JSON.parse(created.value.row.evidence_ref)).toEqual({
        target_kind: "session", target: { session_name: "sess-a" },
      });

      const replay = parsed[`op${SEED + 1}`];
      expect(replay.value.outcome).toBe("already_satisfied");

      const conflict = parsed[`op${SEED + 2}`];
      expect(conflict.value.outcome).toBe("conflict");
      expect(conflict.value.row.evidence_ref).toBe(expectedStoredText);
    } finally {
      await fixture.cleanup();
    }
  }, 300_000);
});
