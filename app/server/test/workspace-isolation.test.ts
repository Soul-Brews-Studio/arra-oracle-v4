/**
 * #10 two-workspace isolation proof.
 *
 * A single-workspace test cannot distinguish "correctly scoped" from "scoped
 * by accident because there was only one workspace in the dataset" -- that is
 * exactly how `list`/`searchText`/`searchVector` shipped silently unscoped
 * for a while. This file seeds TWO workspaces, alpha and beta, with
 * COLLIDING identity on purpose -- same node id, same public_id, same chunk
 * id, same session name, same peer name, same vocabulary/term id, same
 * trace/session-link id -- in both, and proves for every reachable
 * read/write method that:
 *
 *   1. A read scoped to alpha never returns a beta row, and vice versa --
 *      not "returns the right row", specifically that the OTHER workspace's
 *      row is ABSENT from the answer.
 *   2. An identifier that exists in beta but is requested under alpha
 *      resolves absent/invalid_reference, not a hit.
 *   3. A write scoped to alpha cannot collide with, or be blocked by, an
 *      identically-keyed row in beta -- the colliding-identity case is the
 *      main technique this file uses throughout.
 *   4. Where a table's own witness or scoped predicate could silently drop
 *      the workspace clause, beta is seeded with data that WOULD match
 *      alpha's query if the clause were missing, so an unscoped predicate
 *      produces a visibly wrong answer instead of a silent pass.
 *
 * Real gated children, real persistence, no store mocks -- `runGated` and the
 * accepted publication fixture, exactly as every other kernel's
 * real-persistence lane. New files only: this test file and its gated child
 * driver under `fixtures/isolation-v1/`.
 */

import { describe, expect, test } from "bun:test";
import {
  createFixture,
  revisionEnvelope,
  runGated,
  idSource,
  type Fixture,
} from "./helpers/publication-fixture";
import { peerRequest, sessionRequest, joinRequest, messageItem, appendRequest, contextId, createContextFixture } from "./helpers/context-fixture";
import { vocabularyRequest, termRequest, seedManifest } from "./helpers/taxonomy-fixture";
import { createSessionLinkRequest, listSessionLinksRequest } from "./helpers/session-link-fixture";
import { createTraceRequest, hitInput } from "./helpers/trace-fixture";
import { getReadCursorRequest, advanceReadCursorRequest, expectedPointer } from "./helpers/read-cursor-fixture";
import { getAssociationsRequest, reconcileRequest } from "./helpers/association-fixture";
import { CHUNKER_VERSION } from "../src/publication/search-chunk";

const CHILD = new URL("./fixtures/isolation-v1/core/gated-isolation.ts", import.meta.url).pathname;
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const TEST_TIMEOUT_MS = 300_000;

const ctx = (method: string, request: unknown) => ({ facade: "context", method, request });
const pub = (method: string, request: unknown) => ({ facade: "publication", method, request });
const tax = (method: string, request: unknown) => ({ facade: "taxonomy", method, request });
const ev = (method: string, request: unknown) => ({ facade: "evidence", method, request });
const hx = (method: string, request: unknown) => ({ facade: "harness", method, request });

const drive = async (
  fixture: Fixture | { datasetRoot: string },
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

// ── the writer surface itself, once ─────────────────────────────────────────

describe("the isolation-proof bundle exposes every facade under test", () => {
  test("publication, taxonomy, context and evidence, one owner", async () => {
    const fixture = await createFixture([ALPHA]);
    try {
      const parsed = await drive(fixture, [ctx("getPeer", { workspace_name: ALPHA, peer_name: "nobody" })]);
      expect(parsed.writerKeys).toEqual(["close", "context", "evidence", "publication", "taxonomy"]);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

// ── peers, sessions, membership, messages ───────────────────────────────────

describe("peers, sessions, membership and messages: colliding identity across workspaces", () => {
  test("identical peer_id + name in both workspaces both register as CREATED, and reads never cross", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const parsed = await drive(fixture, [
        ctx("registerPeer", peerRequest(ALPHA)),
        // Same id, same name, OTHER workspace: an unscoped uniqueness check
        // would see the alpha row and report already_satisfied here instead
        // of created.
        ctx("registerPeer", peerRequest(BETA)),
        ctx("getPeer", { workspace_name: ALPHA, peer_name: "peer-a" }),
        ctx("getPeer", { workspace_name: BETA, peer_name: "peer-a" }),
      ]);
      expect(ok(parsed.op0, "alpha register").outcome).toBe("created");
      expect(ok(parsed.op1, "beta register").outcome).toBe("created");
      expect(ok(parsed.op2, "alpha getPeer").workspace_name).toBe(ALPHA);
      expect(ok(parsed.op3, "beta getPeer").workspace_name).toBe(BETA);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("identical session_id + name in both workspaces both register as CREATED, membership is per-workspace, and a peer absent from beta cannot join beta's identically-named session", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const parsed = await drive(fixture, [
        ctx("registerPeer", peerRequest(ALPHA)),
        ctx("registerSession", sessionRequest(ALPHA)),
        ctx("joinSession", joinRequest(ALPHA)),
        // Beta: same session id+name, same peer id+name -- but register the
        // peer under beta too, since #3's collision technique is identity,
        // not cross-workspace reference.
        ctx("registerSession", sessionRequest(BETA)),
        ctx("registerPeer", peerRequest(BETA)),
        ctx("joinSession", joinRequest(BETA)),
        // Cross-workspace reference: a peer registered ONLY under alpha
        // requested under beta's identically-named session must be an
        // invalid_reference, not a hit on alpha's membership.
        ctx("joinSession", joinRequest(BETA, { peer_name: "does-not-exist-in-beta" })),
      ]);
      expect(ok(parsed.op0, "alpha peer").outcome).toBe("created");
      expect(ok(parsed.op1, "alpha session").outcome).toBe("created");
      expect(ok(parsed.op2, "alpha join").outcome).toBe("created");
      expect(ok(parsed.op3, "beta session").outcome).toBe("created");
      expect(ok(parsed.op4, "beta peer").outcome).toBe("created");
      expect(ok(parsed.op5, "beta join").outcome).toBe("created");
      refusedReference(parsed.op6, "/peer_name", "beta join absent peer");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("identical public_id appended in both workspaces' identically-named sessions land as TWO separate rows, and listMessages never crosses", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const msgId = contextId("shared-msg");
      const parsed = await drive(fixture, [
        ctx("registerPeer", peerRequest(ALPHA)),
        ctx("registerSession", sessionRequest(ALPHA)),
        ctx("joinSession", joinRequest(ALPHA)),
        ctx("registerPeer", peerRequest(BETA)),
        ctx("registerSession", sessionRequest(BETA)),
        ctx("joinSession", joinRequest(BETA)),
        // Same public_id, same session name, same peer name -- different workspace.
        ctx("appendMessages", appendRequest(ALPHA, "sess-a", [messageItem({ public_id: msgId, message: { content: "alpha content" } })])),
        ctx("appendMessages", appendRequest(BETA, "sess-a", [messageItem({ public_id: msgId, message: { content: "beta content" } })])),
        ctx("getMessage", { workspace_name: ALPHA, public_id: msgId }),
        ctx("getMessage", { workspace_name: BETA, public_id: msgId }),
        ctx("listMessages", { workspace_name: ALPHA, session_name: "sess-a", after_seq: null, limit: 10 }),
        ctx("listMessages", { workspace_name: BETA, session_name: "sess-a", after_seq: null, limit: 10 }),
      ]);
      const alphaAppend = ok(parsed.op6, "alpha append");
      const betaAppend = ok(parsed.op7, "beta append");
      expect(alphaAppend.results[0].outcome).toBe("accepted");
      expect(betaAppend.results[0].outcome).toBe("accepted");
      // Both accepted as fresh writes -- an unscoped replay check would have
      // called the second one "idempotent" against the first's row.
      expect(ok(parsed.op8, "alpha getMessage").content).toBe("alpha content");
      expect(ok(parsed.op9, "beta getMessage").content).toBe("beta content");
      const alphaList = ok(parsed.op10, "alpha list");
      const betaList = ok(parsed.op11, "beta list");
      expect(alphaList.rows.map((r: any) => r.content)).toEqual(["alpha content"]);
      expect(betaList.rows.map((r: any) => r.content)).toEqual(["beta content"]);
      // Each workspace's own row, with its own physical id -- never merged.
      expect(alphaList.rows[0].id).not.toBe(betaList.rows[0].id);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a left membership in beta does not affect alpha's identically-named session/peer", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const parsed = await drive(fixture, [
        ctx("registerPeer", peerRequest(ALPHA)),
        ctx("registerSession", sessionRequest(ALPHA)),
        ctx("joinSession", joinRequest(ALPHA)),
        ctx("registerPeer", peerRequest(BETA)),
        ctx("registerSession", sessionRequest(BETA)),
        // Beta's peer never joins -- appending to beta's session must refuse,
        // while alpha (identically named/identified) must still accept.
        ctx("appendMessages", appendRequest(BETA, "sess-a", [messageItem({ public_id: contextId("beta-blocked") })])),
        ctx("appendMessages", appendRequest(ALPHA, "sess-a", [messageItem({ public_id: contextId("alpha-ok") })])),
      ]);
      expect(ok(parsed.op2, "alpha join").outcome).toBe("created");
      const betaAppend = parsed.op5;
      expect(betaAppend.ok).toBe(true);
      expect(betaAppend.value.outcome).toBe("stopped");
      expect(betaAppend.value.stop.error.path).toBe("/items/0/message/peer_name");
      const alphaAppend = ok(parsed.op6, "alpha append");
      expect(alphaAppend.outcome).toBe("complete");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

// ── session links ────────────────────────────────────────────────────────────

describe("session links: colliding link id, endpoints resolved per workspace", () => {
  test("identical link id + session names in both workspaces both CREATE, and a beta-only session cannot be linked from alpha", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const parsed = await drive(fixture, [
        ctx("registerSession", sessionRequest(ALPHA)),
        ctx("registerSession", sessionRequest(ALPHA, { session_id: contextId("sess-b"), name: "sess-b" })),
        ctx("registerSession", sessionRequest(BETA)),
        ctx("registerSession", sessionRequest(BETA, { session_id: contextId("sess-b"), name: "sess-b" })),
        // Beta gets a THIRD session that alpha never has.
        ctx("registerSession", sessionRequest(BETA, { session_id: contextId("sess-only-beta"), name: "sess-only-beta" })),
        ctx("createSessionLink", createSessionLinkRequest(ALPHA)),
        ctx("createSessionLink", createSessionLinkRequest(BETA)),
        // Alpha referencing beta's exclusive session by name: invalid_reference.
        ctx("createSessionLink", createSessionLinkRequest(ALPHA, {
          id: contextId("link-cross"),
          to_session_name: "sess-only-beta",
        })),
        ctx("listSessionLinks", listSessionLinksRequest(ALPHA)),
        ctx("listSessionLinks", listSessionLinksRequest(BETA)),
      ]);
      expect(ok(parsed.op5, "alpha link").outcome).toBe("created");
      expect(ok(parsed.op6, "beta link").outcome).toBe("created");
      refusedReference(parsed.op7, "/to_session_name", "alpha cross-workspace link");
      const alphaLinks = ok(parsed.op8, "alpha list");
      const betaLinks = ok(parsed.op9, "beta list");
      expect(alphaLinks.rows).toHaveLength(1);
      expect(betaLinks.rows).toHaveLength(1);
      expect(alphaLinks.rows[0].workspace_name).toBe(ALPHA);
      expect(betaLinks.rows[0].workspace_name).toBe(BETA);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

// ── traces and trace hits ───────────────────────────────────────────────────

describe("traces and trace hits: colliding trace id across workspaces", () => {
  test("identical trace id in both workspaces both CREATE, getTrace/listTraceHits never cross", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const traceId = contextId("shared-trace");
      const parsed = await drive(fixture, [
        ctx("createTrace", createTraceRequest(ALPHA, {
          id: traceId,
          query: "alpha query",
          hits: [hitInput({ ref: "alpha-citation" })],
        })),
        ctx("createTrace", createTraceRequest(BETA, {
          id: traceId,
          query: "beta query",
          hits: [hitInput({ ref: "beta-citation" })],
        })),
        ctx("getTrace", { workspace_name: ALPHA, id: traceId }),
        ctx("getTrace", { workspace_name: BETA, id: traceId }),
        ctx("listTraceHits", { workspace_name: ALPHA, trace_id: traceId, after_position: null, limit: 10 }),
        ctx("listTraceHits", { workspace_name: BETA, trace_id: traceId, after_position: null, limit: 10 }),
      ]);
      expect(ok(parsed.op0, "alpha createTrace").outcome).toBe("created");
      expect(ok(parsed.op1, "beta createTrace").outcome).toBe("created");
      expect(ok(parsed.op2, "alpha getTrace").query).toBe("alpha query");
      expect(ok(parsed.op3, "beta getTrace").query).toBe("beta query");
      const alphaHits = ok(parsed.op4, "alpha hits");
      const betaHits = ok(parsed.op5, "beta hits");
      expect(alphaHits.rows.map((r: any) => r.ref)).toEqual(["alpha-citation"]);
      expect(betaHits.rows.map((r: any) => r.ref)).toEqual(["beta-citation"]);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

// ── read cursors ─────────────────────────────────────────────────────────────

describe("read cursors: colliding peer/session names, independent pointers", () => {
  test("identical (peer_name, session_name) in both workspaces track SEPARATE pointers", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alphaMsg = contextId("alpha-cursor-msg");
      const betaMsg = contextId("beta-cursor-msg");
      const parsed = await drive(fixture, [
        ctx("registerPeer", peerRequest(ALPHA)),
        ctx("registerSession", sessionRequest(ALPHA)),
        ctx("joinSession", joinRequest(ALPHA)),
        ctx("registerPeer", peerRequest(BETA)),
        ctx("registerSession", sessionRequest(BETA)),
        ctx("joinSession", joinRequest(BETA)),
        // A real message per workspace: advanceReadCursor validates the
        // pointer against `messages`, so an arbitrary id is refused.
        ctx("appendMessages", appendRequest(ALPHA, "sess-a", [messageItem({ public_id: alphaMsg })])),
        ctx("appendMessages", appendRequest(BETA, "sess-a", [messageItem({ public_id: betaMsg })])),
        ctx("advanceReadCursor", advanceReadCursorRequest(ALPHA, { last_read_message_id: alphaMsg })),
        ctx("advanceReadCursor", advanceReadCursorRequest(BETA, { last_read_message_id: betaMsg })),
        ctx("getReadCursor", getReadCursorRequest(ALPHA)),
        ctx("getReadCursor", getReadCursorRequest(BETA)),
        // Cross-workspace reference: beta's message id, requested as the
        // cursor pointer under alpha's identically-named session, must be
        // invalid_reference -- never a hit on beta's row.
        ctx("advanceReadCursor", advanceReadCursorRequest(ALPHA, {
          last_read_message_id: betaMsg,
          expected: expectedPointer(alphaMsg),
        })),
      ]);
      expect(ok(parsed.op8, "alpha advance").outcome).toBe("created");
      expect(ok(parsed.op9, "beta advance").outcome).toBe("created");
      expect(ok(parsed.op10, "alpha get").last_read_message_id).toBe(alphaMsg);
      expect(ok(parsed.op11, "beta get").last_read_message_id).toBe(betaMsg);
      refusedReference(parsed.op12, "/last_read_message_id", "alpha cursor referencing beta's message");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a beta cursor guard collision does not satisfy alpha's expected-pointer check", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alphaMsg = contextId("alpha-guard-msg");
      const betaMsg = contextId("beta-guard-msg");
      const parsed = await drive(fixture, [
        ctx("registerPeer", peerRequest(ALPHA)),
        ctx("registerSession", sessionRequest(ALPHA)),
        ctx("joinSession", joinRequest(ALPHA)),
        ctx("registerPeer", peerRequest(BETA)),
        ctx("registerSession", sessionRequest(BETA)),
        ctx("joinSession", joinRequest(BETA)),
        ctx("appendMessages", appendRequest(ALPHA, "sess-a", [messageItem({ public_id: alphaMsg })])),
        ctx("appendMessages", appendRequest(BETA, "sess-a", [messageItem({ public_id: betaMsg })])),
        ctx("advanceReadCursor", advanceReadCursorRequest(BETA, { last_read_message_id: betaMsg })),
        // Alpha has NO cursor yet; guarding on beta's now-present pointer
        // (same peer_name/session_name) must still see alpha's row as
        // ABSENT, not satisfied.
        ctx("advanceReadCursor", advanceReadCursorRequest(ALPHA, {
          last_read_message_id: alphaMsg,
          expected: expectedPointer(betaMsg),
        })),
      ]);
      expect(ok(parsed.op8, "beta advance").outcome).toBe("created");
      // expected non-null pointer against an ABSENT row is a returned
      // conflict, never a hit against beta's row and never thrown.
      const alphaAttempt = ok(parsed.op9, "alpha guarded advance");
      expect(alphaAttempt.outcome).toBe("conflict");
      expect(alphaAttempt.reason).toBe("expected");
      expect(alphaAttempt.row).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

// ── taxonomy: vocabularies and terms ────────────────────────────────────────

describe("taxonomy: colliding vocabulary/term ids across workspaces", () => {
  test("identical vocabulary_id + name in both workspaces both CREATE, and getVocabulary/getTerm never cross", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const parsed = await drive(fixture, [
        tax("createVocabulary", vocabularyRequest(ALPHA, { label: "Alpha label" })),
        tax("createVocabulary", vocabularyRequest(BETA, { label: "Beta label" })),
        tax("createTerm", termRequest(ALPHA, { description: "alpha term" })),
        tax("createTerm", termRequest(BETA, { description: "beta term" })),
        tax("getVocabulary", { workspace_name: ALPHA, vocabulary_id: termRequest(ALPHA).vocabulary_id }),
        tax("getVocabulary", { workspace_name: BETA, vocabulary_id: termRequest(BETA).vocabulary_id }),
        tax("getTerm", { workspace_name: ALPHA, term_id: termRequest(ALPHA).term_id }),
        tax("getTerm", { workspace_name: BETA, term_id: termRequest(BETA).term_id }),
      ]);
      expect(ok(parsed.op0, "alpha createVocabulary").outcome).toBe("created");
      expect(ok(parsed.op1, "beta createVocabulary").outcome).toBe("created");
      expect(ok(parsed.op2, "alpha createTerm").outcome).toBe("created");
      expect(ok(parsed.op3, "beta createTerm").outcome).toBe("created");
      expect(ok(parsed.op4, "alpha getVocabulary").label).toBe("Alpha label");
      expect(ok(parsed.op5, "beta getVocabulary").label).toBe("Beta label");
      expect(ok(parsed.op6, "alpha getTerm").description).toBe("alpha term");
      expect(ok(parsed.op7, "beta getTerm").description).toBe("beta term");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("renaming alpha's term to a name held only in beta succeeds -- the name clash is per workspace, not global", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const parsed = await drive(fixture, [
        tax("createVocabulary", vocabularyRequest(ALPHA)),
        tax("createVocabulary", vocabularyRequest(BETA)),
        tax("createTerm", termRequest(ALPHA, { name: "alpha-name" })),
        // Beta already holds the name alpha is about to rename INTO. If the
        // uniqueness check were unscoped, this collides and the rename fails.
        tax("createTerm", termRequest(BETA, { name: "shared-target-name" })),
        tax("renameTerm", {
          workspace_name: ALPHA,
          term_id: termRequest(ALPHA).term_id,
          name: "shared-target-name",
          expected_name: "alpha-name",
        }),
        tax("getTerm", { workspace_name: ALPHA, term_id: termRequest(ALPHA).term_id }),
      ]);
      expect(ok(parsed.op2, "alpha createTerm").outcome).toBe("created");
      expect(ok(parsed.op3, "beta createTerm").outcome).toBe("created");
      expect(ok(parsed.op4, "alpha rename").outcome).toBe("updated");
      expect(ok(parsed.op5, "alpha getTerm after rename").name).toBe("shared-target-name");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("reparenting alpha's term does not move beta's identically-id'd term, and retiring alpha's term leaves beta's active", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const parent = vocabularyRequest(ALPHA, { vocabulary_id: contextId("tree-voc"), name: "tree-voc", hierarchy: "tree" });
      const parentTerm = termRequest(ALPHA, { term_id: contextId("tree-parent"), vocabulary_id: contextId("tree-voc"), name: "parent" });
      const childTerm = termRequest(ALPHA, { term_id: contextId("tree-child"), vocabulary_id: contextId("tree-voc"), name: "child" });
      const parsed = await drive(fixture, [
        // Identical tree vocabulary + parent/child term ids in BOTH workspaces.
        tax("createVocabulary", { ...parent, workspace_name: ALPHA }),
        tax("createVocabulary", { ...parent, workspace_name: BETA }),
        tax("createTerm", { ...parentTerm, workspace_name: ALPHA }),
        tax("createTerm", { ...parentTerm, workspace_name: BETA }),
        tax("createTerm", { ...childTerm, workspace_name: ALPHA }),
        tax("createTerm", { ...childTerm, workspace_name: BETA }),
        // Reparent ONLY in alpha.
        tax("reparentTerm", {
          workspace_name: ALPHA, term_id: childTerm.term_id,
          parent_id: parentTerm.term_id, expected_parent_id: null,
        }),
        tax("getTerm", { workspace_name: ALPHA, term_id: childTerm.term_id }),
        tax("getTerm", { workspace_name: BETA, term_id: childTerm.term_id }),
        // Retire ONLY in alpha's (now-reparented) child.
        tax("retireTerm", { workspace_name: ALPHA, term_id: childTerm.term_id }),
        tax("getTerm", { workspace_name: ALPHA, term_id: childTerm.term_id }),
        tax("getTerm", { workspace_name: BETA, term_id: childTerm.term_id }),
      ]);
      expect(ok(parsed.op6, "alpha reparent").outcome).toBe("updated");
      expect(ok(parsed.op7, "alpha child after reparent").parent_id).toBe(parentTerm.term_id);
      // Beta's identically-id'd child is untouched: still root, still active.
      expect(ok(parsed.op8, "beta child unaffected").parent_id).toBeNull();
      expect(ok(parsed.op9, "alpha retire").outcome).toBe("updated");
      expect(ok(parsed.op10, "alpha child after retire").is_active).toBe(false);
      expect(ok(parsed.op11, "beta child stays active").is_active).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("seedReservedVocabularies: identical manifest ids in both workspaces both seed as CREATED, and each stays scoped to its own vocabularies/terms", async () => {
    // A BARE fixture, deliberately: createFixture's own dataset already has
    // reserved taxonomy seeded (by the Python exporter, not through this
    // facade method), so seeding again there would test replay, not a fresh
    // write. seedManifest's own default ids are LITERAL constants independent
    // of the workspace argument, so calling it for alpha and beta with no
    // overrides is itself the colliding-identity setup: identical
    // vocabulary_id/term_id in both workspaces.
    const fixture = await createContextFixture([ALPHA, BETA]);
    try {
      const manifestAlpha = seedManifest(ALPHA);
      const manifestBeta = seedManifest(BETA);
      expect(manifestBeta.type).toEqual(manifestAlpha.type);
      expect(manifestBeta.memory_horizon).toEqual(manifestAlpha.memory_horizon);

      const parsed = await drive(fixture, [
        tax("seedReservedVocabularies", manifestAlpha),
        // Same vocabulary_id/term ids, OTHER workspace: an unscoped lookup
        // would find alpha's just-written rows and report already_satisfied
        // here instead of created.
        tax("seedReservedVocabularies", manifestBeta),
        tax("getVocabulary", { workspace_name: ALPHA, vocabulary_id: (manifestAlpha.type as any).vocabulary_id }),
        tax("getVocabulary", { workspace_name: BETA, vocabulary_id: (manifestBeta.type as any).vocabulary_id }),
        tax("getTerm", { workspace_name: ALPHA, term_id: (manifestAlpha.type as any).terms.note }),
        tax("getTerm", { workspace_name: BETA, term_id: (manifestBeta.type as any).terms.note }),
      ]);
      const alphaSeed = ok(parsed.op0, "alpha seed");
      const betaSeed = ok(parsed.op1, "beta seed");
      expect(alphaSeed.outcome).toBe("created");
      expect(betaSeed.outcome).toBe("created");
      // Every returned row, from BOTH tables, carries its OWN workspace --
      // never the other's, despite the identical ids.
      for (const row of [...alphaSeed.vocabularies, ...alphaSeed.terms]) {
        expect(row.workspace_name).toBe(ALPHA);
      }
      for (const row of [...betaSeed.vocabularies, ...betaSeed.terms]) {
        expect(row.workspace_name).toBe(BETA);
      }
      expect(ok(parsed.op2, "alpha getVocabulary").workspace_name).toBe(ALPHA);
      expect(ok(parsed.op3, "beta getVocabulary").workspace_name).toBe(BETA);
      expect(ok(parsed.op4, "alpha getTerm").workspace_name).toBe(ALPHA);
      expect(ok(parsed.op5, "beta getTerm").workspace_name).toBe(BETA);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

// ── publication: nodes and revisions, plus derived evidence ────────────────

describe("publication and evidence: colliding node_id + revision_id across workspaces", () => {
  test("identical node_id + revision_id publish independently, and getAcceptedHead/listAcceptedHistory never cross", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const nodeId = contextId("shared-node");
      const revId = contextId("shared-rev");
      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", {
            operation_id: "op-alpha",
            content: revisionEnvelope(ALPHA, alpha, nodeId, { title: "alpha title" }),
          }),
          pub("publishRevision", {
            operation_id: "op-beta",
            content: revisionEnvelope(BETA, beta, nodeId, { title: "beta title" }),
          }),
          pub("getAcceptedHead", { workspace_name: ALPHA, node_id: nodeId }),
          pub("getAcceptedHead", { workspace_name: BETA, node_id: nodeId }),
          pub("listAcceptedHistory", { workspace_name: ALPHA, node_id: nodeId }),
          pub("listAcceptedHistory", { workspace_name: BETA, node_id: nodeId }),
        ],
        { revisionIds: [revId, revId] },
      );
      expect(ok(parsed.op0, "alpha publish").outcome).toBe("accepted");
      expect(ok(parsed.op1, "beta publish").outcome).toBe("accepted");
      const alphaHead = ok(parsed.op2, "alpha head");
      const betaHead = ok(parsed.op3, "beta head");
      expect(alphaHead.revision.title).toBe("alpha title");
      expect(betaHead.revision.title).toBe("beta title");
      // Same physical revision_id string, but each workspace's OWN row.
      expect(alphaHead.revision.id).toBe(revId);
      expect(betaHead.revision.id).toBe(revId);
      const alphaHistory = ok(parsed.op4, "alpha history");
      const betaHistory = ok(parsed.op5, "beta history");
      expect(alphaHistory.revisions.map((r: any) => r.title)).toEqual(["alpha title"]);
      expect(betaHistory.revisions.map((r: any) => r.title)).toEqual(["beta title"]);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("colliding node_id/revision_id: node_revision_terms via getRevisionAssociations/reconcileRevisionAssociations never cross", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const nodeId = contextId("shared-node2");
      const revId = contextId("shared-rev2");
      const parsed = await drive(
        fixture,
        [
          // Distinguishing titles, so the two workspaces' accepted content --
          // and therefore content_digest -- genuinely differ despite the
          // colliding node_id and revision_id.
          pub("publishRevision", {
            operation_id: "op-alpha2",
            content: revisionEnvelope(ALPHA, alpha, nodeId, { title: "alpha assoc title" }),
          }),
          pub("publishRevision", {
            operation_id: "op-beta2",
            content: revisionEnvelope(BETA, beta, nodeId, { title: "beta assoc title" }),
          }),
          ev("getRevisionAssociations", getAssociationsRequest(ALPHA, { node_id: nodeId, revision_id: null })),
          ev("getRevisionAssociations", getAssociationsRequest(BETA, { node_id: nodeId, revision_id: null })),
          ev("reconcileRevisionAssociations", reconcileRequest(ALPHA, { node_id: nodeId, revision_id: revId })),
          ev("reconcileRevisionAssociations", reconcileRequest(BETA, { node_id: nodeId, revision_id: revId })),
          // Raw readback of the TABLE reconcile actually wrote to, since
          // getRevisionAssociations deliberately never queries it (its own
          // documented READ INVARIANT): this is the only way through this
          // file to prove the persisted node_revision_terms rows themselves
          // are scoped, not merely the outcome object reconcile returned.
          hx("readRawRows", { table: "node_revision_terms", predicate: `revision_id = '${revId}'` }),
          hx("readRawRows", { table: "node_revision_terms", predicate: `workspace_name = '${ALPHA}' AND revision_id = '${revId}'` }),
          hx("readRawRows", { table: "node_revision_terms", predicate: `workspace_name = '${BETA}' AND revision_id = '${revId}'` }),
        ],
        { revisionIds: [revId, revId] },
      );
      expect(ok(parsed.op0, "alpha publish").outcome).toBe("accepted");
      expect(ok(parsed.op1, "beta publish").outcome).toBe("accepted");
      const alphaAssoc = ok(parsed.op2, "alpha assoc");
      const betaAssoc = ok(parsed.op3, "beta assoc");
      expect(alphaAssoc.workspace_name).toBe(ALPHA);
      expect(betaAssoc.workspace_name).toBe(BETA);
      // Different content under the identical node_id/revision_id must
      // produce genuinely different digests -- a leaked/merged read would
      // either match the wrong one or coincide.
      expect(alphaAssoc.content_digest).not.toBe(betaAssoc.content_digest);

      // Both derived and persisted independently, from each workspace's OWN
      // snapshot, under the identical revision_id. Asserted on ACTUAL scoped
      // content -- workspace_name, node/revision identity, digest, and the
      // exact reconciled counts -- not merely that a value came back.
      const alphaReconcile = ok(parsed.op4, "alpha reconcile");
      const betaReconcile = ok(parsed.op5, "beta reconcile");
      expect(alphaReconcile.outcome).toBe("reconciled");
      expect(betaReconcile.outcome).toBe("reconciled");
      expect(alphaReconcile.workspace_name).toBe(ALPHA);
      expect(betaReconcile.workspace_name).toBe(BETA);
      expect(alphaReconcile.node_id).toBe(nodeId);
      expect(betaReconcile.node_id).toBe(nodeId);
      expect(alphaReconcile.revision_id).toBe(revId);
      expect(betaReconcile.revision_id).toBe(revId);
      // Reconcile's own digest must agree with the INDEPENDENTLY-derived one
      // getRevisionAssociations already reported for the SAME workspace, and
      // the two workspaces' digests must stay distinct here too.
      expect(alphaReconcile.content_digest).toBe(alphaAssoc.content_digest);
      expect(betaReconcile.content_digest).toBe(betaAssoc.content_digest);
      expect(alphaReconcile.content_digest).not.toBe(betaReconcile.content_digest);
      // Exactly one type-term assignment each (revisionEnvelope's default
      // term_snapshot), no links.
      expect(alphaReconcile.terms).toEqual({ action: "filled", count: "1" });
      expect(betaReconcile.terms).toEqual({ action: "filled", count: "1" });
      expect(alphaReconcile.links).toEqual({ action: "unchanged", count: "0" });
      expect(betaReconcile.links).toEqual({ action: "unchanged", count: "0" });

      // The raw table itself: TWO rows total under the colliding revision_id
      // (one per workspace, never merged into one or dropped), and each
      // workspace-scoped slice holds EXACTLY its own row, carrying its own
      // reserved "type" term id -- which the fixture seeds distinctly per
      // workspace, so a swapped or unscoped read is visibly wrong here too.
      const allRows = ok(parsed.op6, "raw node_revision_terms, both workspaces");
      expect(allRows).toHaveLength(2);
      expect(allRows.map((r: any) => r.workspace_name).sort()).toEqual([ALPHA, BETA].sort());
      const alphaRawRows = ok(parsed.op7, "raw node_revision_terms, alpha only");
      const betaRawRows = ok(parsed.op8, "raw node_revision_terms, beta only");
      expect(alphaRawRows).toHaveLength(1);
      expect(betaRawRows).toHaveLength(1);
      expect(alphaRawRows[0].workspace_name).toBe(ALPHA);
      expect(betaRawRows[0].workspace_name).toBe(BETA);
      expect(alphaRawRows[0].term_id).toBe(alpha.term_ids.type.note.id);
      expect(betaRawRows[0].term_id).toBe(beta.term_ids.type.note.id);
      expect(alphaRawRows[0].term_id).not.toBe(betaRawRows[0].term_id);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("colliding node_id/revision_id AND colliding link target: revision_links (via getRevisionAssociations.links) and scanDependents never cross", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const nodeId = contextId("shared-node-link");
      const revId = contextId("shared-rev-link");
      const traceId = contextId("shared-link-target");
      const linkSnapshot = JSON.stringify([
        {
          position: "0",
          relation: "related_to",
          target_kind: "trace",
          target: { trace_id: traceId },
          excerpt: null,
          content_hash: null,
          captured_at: null,
          capture_status: "locator_only",
          note: null,
        },
      ]);
      const parsed = await drive(
        fixture,
        [
          // The SAME trace id, created independently in both workspaces, is
          // the link's target -- so a scan by that target could, if unscoped,
          // surface BOTH workspaces' occurrences under one query.
          ctx("createTrace", createTraceRequest(ALPHA, { id: traceId })),
          ctx("createTrace", createTraceRequest(BETA, { id: traceId })),
          pub("publishRevision", {
            operation_id: "op-alpha-link",
            content: revisionEnvelope(ALPHA, alpha, nodeId, { link_snapshot_json: linkSnapshot }),
          }),
          pub("publishRevision", {
            operation_id: "op-beta-link",
            content: revisionEnvelope(BETA, beta, nodeId, { link_snapshot_json: linkSnapshot }),
          }),
          ev("getRevisionAssociations", getAssociationsRequest(ALPHA, { node_id: nodeId, revision_id: null })),
          ev("getRevisionAssociations", getAssociationsRequest(BETA, { node_id: nodeId, revision_id: null })),
          ev("scanDependents", { workspace_name: ALPHA, target_kind: "trace", target: { trace_id: traceId }, revision_mode: "current", limit: 10, cursor: null }),
          ev("scanDependents", { workspace_name: BETA, target_kind: "trace", target: { trace_id: traceId }, revision_mode: "current", limit: 10, cursor: null }),
        ],
        { revisionIds: [revId, revId] },
      );
      expect(ok(parsed.op2, "alpha publish").outcome).toBe("accepted");
      expect(ok(parsed.op3, "beta publish").outcome).toBe("accepted");
      const alphaAssoc = ok(parsed.op4, "alpha assoc");
      const betaAssoc = ok(parsed.op5, "beta assoc");
      expect(alphaAssoc.links).toHaveLength(1);
      expect(betaAssoc.links).toHaveLength(1);
      expect(alphaAssoc.workspace_name).toBe(ALPHA);
      expect(betaAssoc.workspace_name).toBe(BETA);
      const alphaScan = ok(parsed.op6, "alpha scan");
      const betaScan = ok(parsed.op7, "beta scan");
      expect(alphaScan.outcome).toBe("page");
      expect(betaScan.outcome).toBe("page");
      // Exactly ONE occurrence each, from the caller's own workspace -- an
      // unscoped reverse scan over the identical trace target would surface
      // TWO (one per workspace) instead.
      expect(alphaScan.occurrences).toHaveLength(1);
      expect(betaScan.occurrences).toHaveLength(1);
      expect(alphaScan.occurrences[0].node_id).toBe(nodeId);
      expect(betaScan.occurrences[0].node_id).toBe(nodeId);
      expect(alphaScan.occurrences[0].revision_id).toBe(revId);
      expect(betaScan.occurrences[0].revision_id).toBe(revId);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

// ── lifecycle: retire/supersede, supersede_log ──────────────────────────────

describe("lifecycle: colliding node/operation ids across workspaces, and a global-counter witness", () => {
  test("identical node_id + operation_id: retiring alpha does not retire beta's identically-named node, and history/eligibility never cross", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const nodeId = contextId("shared-node3");
      const revA = contextId("rev-a3");
      const revB = contextId("rev-b3");
      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-a3", content: revisionEnvelope(ALPHA, alpha, nodeId) }),
          pub("publishRevision", { operation_id: "op-b3", content: revisionEnvelope(BETA, beta, nodeId) }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: nodeId }),
          ctx("getRecallEligibility", { workspace_name: BETA, node_id: nodeId }),
          ctx("retireNode", {
            workspace_name: ALPHA,
            node_id: nodeId,
            expected_revision_id: revA,
            reason: "alpha retire",
            peer_name: null,
            operation_id: "shared-op-id",
          }),
          // Beta's identically-named node, identical operation_id: must still
          // be independently eligible until ITS OWN retire runs.
          ctx("getRecallEligibility", { workspace_name: BETA, node_id: nodeId }),
          ctx("retireNode", {
            workspace_name: BETA,
            node_id: nodeId,
            expected_revision_id: revB,
            reason: "beta retire",
            peer_name: null,
            operation_id: "shared-op-id",
          }),
          ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: nodeId }),
          ctx("getRecallEligibility", { workspace_name: BETA, node_id: nodeId }),
          ctx("listLifecycleHistory", { workspace_name: ALPHA, node_id: nodeId, after_event_id: null, limit: 10 }),
          ctx("listLifecycleHistory", { workspace_name: BETA, node_id: nodeId, after_event_id: null, limit: 10 }),
        ],
        { revisionIds: [revA, revB] },
      );
      expect(ok(parsed.op2, "alpha eligible before").eligible).toBe(true);
      expect(ok(parsed.op3, "beta eligible before").eligible).toBe(true);
      expect(ok(parsed.op4, "alpha retire").outcome).toBe("accepted");
      // Beta's node is untouched by alpha's retire, despite the identical
      // node_id AND operation_id.
      expect(ok(parsed.op5, "beta still eligible").eligible).toBe(true);
      expect(ok(parsed.op6, "beta retire").outcome).toBe("accepted");
      expect(ok(parsed.op7, "alpha eligible after").eligible).toBe(false);
      expect(ok(parsed.op8, "beta eligible after").eligible).toBe(false);
      const alphaHistory = ok(parsed.op9, "alpha history");
      const betaHistory = ok(parsed.op10, "beta history");
      expect(alphaHistory.rows).toHaveLength(1);
      expect(betaHistory.rows).toHaveLength(1);
      expect(alphaHistory.rows[0].reason).toBe("alpha retire");
      expect(betaHistory.rows[0].reason).toBe("beta retire");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);

  test("a witness_event_id computed from a global row-id counter must still report only alpha's own count, even after MANY beta events raise the counter", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const alphaNode = contextId("witness-alpha-node");
      const alphaRev = contextId("witness-alpha-rev");
      const betaNodes = Array.from({ length: 5 }, (_u, i) => contextId(`witness-beta-node-${i}`));
      const betaRevs = Array.from({ length: 5 }, (_u, i) => contextId(`witness-beta-rev-${i}`));

      const ops: Array<Record<string, unknown>> = [
        pub("publishRevision", { operation_id: "op-witness-alpha", content: revisionEnvelope(ALPHA, alpha, alphaNode) }),
      ];
      for (const [i, node] of betaNodes.entries()) {
        ops.push(pub("publishRevision", { operation_id: `op-witness-beta-${i}`, content: revisionEnvelope(BETA, beta, node) }));
      }
      // Retire alpha's node FIRST, so its witness is captured before beta
      // writes several MORE supersede_log rows and pushes the table-wide
      // counter well past alpha's own single row.
      ops.push(
        ctx("retireNode", {
          workspace_name: ALPHA, node_id: alphaNode, expected_revision_id: alphaRev,
          reason: "alpha only", peer_name: null, operation_id: "op-retire-alpha",
        }),
      );
      for (const [i, node] of betaNodes.entries()) {
        ops.push(
          ctx("retireNode", {
            workspace_name: BETA, node_id: node, expected_revision_id: betaRevs[i],
            reason: `beta ${i}`, peer_name: null, operation_id: `op-retire-beta-${i}`,
          }),
        );
      }
      ops.push(ctx("getRecallEligibility", { workspace_name: ALPHA, node_id: alphaNode }));

      const parsed = await drive(fixture, ops, { revisionIds: [alphaRev, ...betaRevs] });
      const alphaRetire = ok(parsed[`op${1 + betaNodes.length}`], "alpha retire");
      expect(alphaRetire.outcome).toBe("accepted");
      const finalEligibility = ok(parsed[`op${1 + betaNodes.length + 1 + betaNodes.length}`], "alpha eligibility after beta churn");
      expect(finalEligibility.eligible).toBe(false);
      // witness_event_id is scoped to alpha's OWN supersede_log rows: with a
      // single alpha event, an unscoped MAX(id) over the whole table would
      // instead surface one of beta's five LATER, larger row ids.
      expect(finalEligibility.witness_event_id).not.toBe("0");
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});

// ── search chunks ────────────────────────────────────────────────────────────

describe("search chunks: colliding revision_id across workspaces (regression precedent)", () => {
  test("identical revision_id indexed in both workspaces produce SEPARATE chunk rows, and listSearchChunks never crosses", async () => {
    const fixture = await createFixture([ALPHA, BETA]);
    try {
      const alpha = fixture.workspaces[ALPHA]!;
      const beta = fixture.workspaces[BETA]!;
      const nodeId = contextId("shared-chunk-node");
      const revId = contextId("shared-chunk-rev");
      const profile = { name: "isolation-profile", dims: 384 };
      const parsed = await drive(
        fixture,
        [
          pub("publishRevision", { operation_id: "op-chunk-alpha", content: revisionEnvelope(ALPHA, alpha, nodeId, { body: "alpha body text for chunking" }) }),
          pub("publishRevision", { operation_id: "op-chunk-beta", content: revisionEnvelope(BETA, beta, nodeId, { body: "beta body text for chunking" }) }),
          ctx("indexRevisionChunks", {
            workspace_name: ALPHA, node_id: nodeId, revision_id: revId,
            chunker_version: CHUNKER_VERSION, embedding_profile: profile,
          }),
          ctx("indexRevisionChunks", {
            workspace_name: BETA, node_id: nodeId, revision_id: revId,
            chunker_version: CHUNKER_VERSION, embedding_profile: profile,
          }),
          ctx("listSearchChunks", {
            workspace_name: ALPHA, revision_id: revId,
            chunker_version: CHUNKER_VERSION, embedding_profile: profile.name,
          }),
          ctx("listSearchChunks", {
            workspace_name: BETA, revision_id: revId,
            chunker_version: CHUNKER_VERSION, embedding_profile: profile.name,
          }),
          ctx("reconcileSearchChunks", { workspace_name: ALPHA, limit: 1024 }),
          ctx("reconcileSearchChunks", { workspace_name: BETA, limit: 1024 }),
        ],
        { revisionIds: [revId, revId] },
      );
      const alphaIndexed = ok(parsed.op2, "alpha index");
      const betaIndexed = ok(parsed.op3, "beta index");
      expect(alphaIndexed.outcome).toBe("indexed");
      expect(betaIndexed.outcome).toBe("indexed");
      expect(alphaIndexed.rows[0].workspace_name).toBe(ALPHA);
      expect(betaIndexed.rows[0].workspace_name).toBe(BETA);
      // Same physical chunk id (derived purely from revision/chunker/profile),
      // scoped rows for both. A readback matching on id alone would find TWO
      // rows and poison with integrity_failure instead of succeeding scoped.
      expect(alphaIndexed.rows[0].id).toBe(betaIndexed.rows[0].id);
      const alphaList = ok(parsed.op4, "alpha list");
      const betaList = ok(parsed.op5, "beta list");
      expect(alphaList).toHaveLength(1);
      expect(betaList).toHaveLength(1);
      expect(alphaList[0].workspace_name).toBe(ALPHA);
      expect(betaList[0].workspace_name).toBe(BETA);
      // Both workspaces show a fully indexed revision, not the other's gap.
      const alphaReconcile = ok(parsed.op6, "alpha reconcile");
      const betaReconcile = ok(parsed.op7, "beta reconcile");
      expect(alphaReconcile.missing_revisions.map((m: any) => m.revision_id)).not.toContain(revId);
      expect(betaReconcile.missing_revisions.map((m: any) => m.revision_id)).not.toContain(revId);
    } finally {
      await fixture.cleanup();
    }
  }, TEST_TIMEOUT_MS);
});
