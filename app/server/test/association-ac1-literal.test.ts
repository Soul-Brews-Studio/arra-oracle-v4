/**
 * #28 AC1, the LITERAL end-to-end case (docs/overnight/AC-MATRIX.md, #28
 * section; docs/overnight/FOREIGN-VISITOR.md §5): "A conclusion can cite two
 * traces and two sessions, and reverse lookups retain all results."
 *
 * Every prior association test either seeds physical rows directly
 * (`association-query.test.ts`, kernel-level fixture rows, no real session/
 * trace ever created) or exercises the 13-method transport wiring for
 * CREATING traces and session links (`knowledge-expose13-live.test.ts`) --
 * that file never publishes a revision that cites them, and never calls
 * `scanDependents` or `getRevisionAssociations`. None of them publish
 * ONE revision through the REAL `publishRevision` service whose
 * `link_snapshot` cites two REAL sessions (created via `registerSession` +
 * `joinSession` + `appendMessages`, with an actual message in each) and two
 * REAL traces (created via `createTrace`), and then check that the reverse
 * lookup the contract promises -- `scanDependents` (association-evidence-v1
 * §2) -- returns exactly those four occurrences, each with its own relation.
 * That is the literal AC1 case, and it was untested.
 *
 * Real writer-gated dataset, real gate (fd 42), real service calls end to
 * end -- the same `openEvidenceWriter` bundle and gated-child harness
 * `association-service.test.ts` already uses. Nothing here is a fake or a
 * direct row insert; `service.validateLinkReferences.ts` requires the cited
 * session/trace rows to actually exist, so this test cannot pass by
 * accident.
 *
 * Contract: app/docs/contracts/association-evidence-v1.md §2, §7 ("Two
 * traces/two sessions ... exact occurrence sets, not counts alone").
 */

import { describe, expect, test } from "bun:test";
import {
  createFixture as createSeededRevisionFixture,
  revisionEnvelope,
  runGated,
} from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const ALPHA = "alpha-workspace";
/** The cross-workspace distractor lives here -- never in ALPHA. */
const BETA = "beta-workspace";
const CLOCK = Date.parse("2026-09-27T00:00:00.000Z");
const CHILD = new URL("./fixtures/association-v1/core/gated-association.ts", import.meta.url).pathname;

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

const NODE_A = pad("ac1nodeA");
const PEER_1 = pad("ac1peer1");
const SESSION_1_ID = pad("ac1sess1");
const SESSION_2_ID = pad("ac1sess2");
const SESSION_1_NAME = "ac1-literal-session-one";
const SESSION_2_NAME = "ac1-literal-session-two";
const TRACE_1 = pad("ac1trace1");
const TRACE_2 = pad("ac1trace2");
const MSG_1 = pad("ac1msg1");
const MSG_2 = pad("ac1msg2");
const DISTRACT_SESSION_ID = pad("ac1distrs");
const DISTRACT_NODE = pad("ac1distrn");
const REV_A = pad("ac1revA");

/** Distinct relation per citation, so a mixed-up reverse lookup is caught,
 *  not just a missing/extra one. */
const linkEntry = (position: number, relation: string, kind: string, target: Record<string, unknown>) => ({
  position: String(position),
  relation,
  target_kind: kind,
  target,
  excerpt: null,
  content_hash: null,
  captured_at: null,
  capture_status: "locator_only",
  note: null,
});

const EXPECTED_LINKS = [
  { position: 0, relation: "supports", kind: "trace", target: { trace_id: TRACE_1 } },
  { position: 1, relation: "derived_from", kind: "trace", target: { trace_id: TRACE_2 } },
  { position: 2, relation: "discusses", kind: "session", target: { session_name: SESSION_1_NAME } },
  { position: 3, relation: "related_to", kind: "session", target: { session_name: SESSION_2_NAME } },
] as const;

function traceRequest(id: string): Record<string, unknown> {
  return {
    workspace_name: ALPHA,
    id,
    name: "ac1-literal-trace",
    session_name: null,
    peer_name: null,
    query: "find the two traces and two sessions",
    mode: null,
    session_id: null,
    session_from_ts: null,
    session_to_ts: null,
    friction_score: null,
    confidence: null,
    parent_id: null,
    prev_id: null,
    depth: "0",
    status: "open",
    h_metadata: null,
    internal_metadata: null,
    hits: [],
  };
}

function messageItem(publicId: string, text: string): Record<string, unknown> {
  return {
    public_id: publicId,
    message: { peer_name: "ac1-author", role: "user", content: text, in_reply_to: null },
    source: null,
  };
}

const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const ev = (method: string, request: unknown) => ({ facade: "evidence", method, request });

const scanRequest = (kind: string, target: Record<string, unknown>) => ({
  workspace_name: ALPHA,
  target_kind: kind,
  target,
  revision_mode: "current",
  limit: 10,
  cursor: null,
});

const drive = async (root: string, ops: Array<Record<string, unknown>>): Promise<Record<string, any>> => {
  const result = await runGated(root, CHILD, [
    root,
    JSON.stringify({ ops, clockMs: CLOCK, revisionIds: [REV_A] }),
  ]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 700)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 700)}`);
  return JSON.parse(line);
};

describe("#28 AC1 literal: one conclusion cites 2 traces + 2 sessions; every reverse lookup retains all four", () => {
  test(
    "seeded through the REAL service (registerSession/joinSession/appendMessages/createTrace/publishRevision); " +
      "scanDependents and getRevisionAssociations both return exactly the 4 citations, with their own relations",
    async () => {
      const fixture = await createSeededRevisionFixture([ALPHA, BETA]);
      try {
        const seeded = fixture.workspaces[ALPHA]!;
        const seededBeta = fixture.workspaces[BETA]!;
        const ops = [
          // ── two real sessions, each with a real message ─────────────────
          ctx("registerPeer", { workspace_name: ALPHA, peer_id: PEER_1, name: "ac1-author" }), // op0
          ctx("registerSession", { workspace_name: ALPHA, session_id: SESSION_1_ID, name: SESSION_1_NAME }), // op1
          ctx("joinSession", { workspace_name: ALPHA, session_name: SESSION_1_NAME, peer_name: "ac1-author" }), // op2
          ctx("appendMessages", {
            workspace_name: ALPHA,
            session_name: SESSION_1_NAME,
            items: [messageItem(MSG_1, "message in session one")],
          }), // op3
          ctx("registerSession", { workspace_name: ALPHA, session_id: SESSION_2_ID, name: SESSION_2_NAME }), // op4
          ctx("joinSession", { workspace_name: ALPHA, session_name: SESSION_2_NAME, peer_name: "ac1-author" }), // op5
          ctx("appendMessages", {
            workspace_name: ALPHA,
            session_name: SESSION_2_NAME,
            items: [messageItem(MSG_2, "message in session two")],
          }), // op6
          // ── two real traces ──────────────────────────────────────────────
          ctx("createTrace", traceRequest(TRACE_1)), // op7
          ctx("createTrace", traceRequest(TRACE_2)), // op8
          // ── one conclusion citing all four ───────────────────────────────
          pub("publishRevision", {
            operation_id: "ac1-literal-op-1",
            content: revisionEnvelope(ALPHA, seeded, NODE_A, {
              session_name: null,
              link_snapshot_json: JSON.stringify(
                EXPECTED_LINKS.map((l) => linkEntry(l.position, l.relation, l.kind, { ...l.target })),
              ),
            }),
          }), // op9
          // ── reverse lookup, one call per cited source ────────────────────
          ev("scanDependents", scanRequest("trace", { trace_id: TRACE_1 })), // op10
          ev("scanDependents", scanRequest("trace", { trace_id: TRACE_2 })), // op11
          ev("scanDependents", scanRequest("session", { session_name: SESSION_1_NAME })), // op12
          ev("scanDependents", scanRequest("session", { session_name: SESSION_2_NAME })), // op13
          // ── forward citations, from the conclusion's own side ────────────
          ev("getRevisionAssociations", { workspace_name: ALPHA, node_id: NODE_A, revision_id: null }), // op14
          // ── CROSS-WORKSPACE DISTRACTOR ──────────────────────────────────
          // beta-workspace publishes its OWN revision, on its OWN node,
          // citing a session with the SAME NAME as SESSION_1_NAME above.
          // `deriveLinkRows` (association.deriveLinkRows.ts) always
          // recomputes `target_key` from the REQUESTED workspace, not the
          // node's real one, so the only thing that keeps this distractor
          // out of alpha-workspace's reverse lookup is the per-node
          // workspace predicate in scanDependents (service.scanDependents.ts
          // around line 121). If that predicate were ever dropped, this
          // same-named session in beta-workspace would recompute to the
          // SAME target_key as alpha-workspace's real citation and leak in.
          ctx("registerSession", { workspace_name: BETA, session_id: DISTRACT_SESSION_ID, name: SESSION_1_NAME }), // op15
          pub("publishRevision", {
            operation_id: "ac1-literal-distractor-op",
            content: revisionEnvelope(BETA, seededBeta, DISTRACT_NODE, {
              session_name: null,
              link_snapshot_json: JSON.stringify([
                linkEntry(0, "related_to", "session", { session_name: SESSION_1_NAME }),
              ]),
            }),
          }), // op16
          ev("scanDependents", scanRequest("session", { session_name: SESSION_1_NAME })), // op17
        ];

        const parsed = await drive(fixture.datasetRoot, ops);

        // Setup ops all really wrote through the real service.
        for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
          expect(parsed[`op${i}`].ok).toBe(true);
        }

        // The conclusion was actually accepted, on the node this test owns.
        const published = parsed.op9;
        expect(published.ok).toBe(true);
        expect(published.value.outcome).toBe("accepted");
        expect(published.value.node_id).toBe(NODE_A);
        expect(published.value.revision_id).toBe(REV_A);

        // AC1's own words: "reverse lookups retain all results" -- checked
        // one call per cited source, each an INDEPENDENT scanDependents scan
        // (not one call whose result is sliced four ways).
        const scanOps = ["op10", "op11", "op12", "op13"] as const;
        scanOps.forEach((opName, i) => {
          const expected = EXPECTED_LINKS[i]!;
          const result = parsed[opName];
          expect(result.ok).toBe(true);
          expect(result.value.outcome).toBe("page");
          expect(result.value.occurrences).toHaveLength(1);
          // A truncated scan (MAX_* caps hit, or a bug that stops early)
          // would still be able to carry a single occurrence -- only a null
          // cursor proves the reverse lookup actually reached the end of
          // this workspace's nodes rather than merely finding one match and
          // stopping. Without this, a mutant that made the scan give up
          // after the first hit would pass unnoticed.
          expect(result.value.next_cursor).toBeNull();
          const occurrence = result.value.occurrences[0];
          expect(occurrence.workspace_name).toBe(ALPHA);
          expect(occurrence.node_id).toBe(NODE_A);
          expect(occurrence.revision_id).toBe(REV_A);
          expect(occurrence.revision_no).toBe("1");
          expect(occurrence.is_snapshot_head).toBe(true);
          expect(occurrence.link.target_kind).toBe(expected.kind);
          // `link.target` is the canonicalized JSON TEXT of the target
          // object (association-evidence-v1.md §3), not a decoded object.
          expect(JSON.parse(occurrence.link.target)).toEqual(expected.target);
          expect(occurrence.link.relation).toBe(expected.relation);
          expect(occurrence.link.position).toBe(String(expected.position));
        });

        // The forward side agrees: the same 4 links, same order, same
        // relations -- one revision, four citations, both directions correct.
        const associations = parsed.op14;
        expect(associations.ok).toBe(true);
        expect(associations.value.node_id).toBe(NODE_A);
        expect(associations.value.revision_id).toBe(REV_A);
        expect(associations.value.links).toHaveLength(4);
        associations.value.links.forEach((link: Record<string, unknown>, i: number) => {
          const expected = EXPECTED_LINKS[i]!;
          expect(link.target_kind).toBe(expected.kind);
          expect(JSON.parse(link.target as string)).toEqual(expected.target);
          expect(link.relation).toBe(expected.relation);
          expect(link.position).toBe(String(expected.position));
        });

        // The distractor setup itself really wrote, on the real service, in
        // the real other workspace.
        expect(parsed.op15.ok).toBe(true);
        const distractorPublished = parsed.op16;
        expect(distractorPublished.ok).toBe(true);
        expect(distractorPublished.value.outcome).toBe("accepted");
        expect(distractorPublished.value.node_id).toBe(DISTRACT_NODE);

        // With the distractor now sitting in beta-workspace under the SAME
        // session name, alpha-workspace's reverse lookup for that name must
        // still return exactly the one alpha-workspace occurrence -- not
        // two. This is the assertion that goes red if the workspace
        // predicate in scanDependents is ever dropped.
        const guarded = parsed.op17;
        expect(guarded.ok).toBe(true);
        expect(guarded.value.outcome).toBe("page");
        expect(guarded.value.occurrences).toHaveLength(1);
        expect(guarded.value.next_cursor).toBeNull();
        const guardedOccurrence = guarded.value.occurrences[0];
        expect(guardedOccurrence.workspace_name).toBe(ALPHA);
        expect(guardedOccurrence.node_id).toBe(NODE_A);
        expect(guardedOccurrence.revision_id).toBe(REV_A);
        expect(guardedOccurrence.link.relation).toBe("discusses");
      } finally {
        await fixture.cleanup();
      }
    },
    testTimeout(300_000),
  );
});
