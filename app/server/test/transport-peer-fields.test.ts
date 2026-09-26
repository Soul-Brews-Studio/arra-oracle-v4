// #87 / R3 (docs/overnight/DECISIONS.md): the table of caller-asserted peer
// fields (`registry.peerFields.ts`) cannot silently fall behind the registry.
//
// The binding is only as complete as that hand-kept table: a knowledge method
// whose grammar carries an acting peer (#28's `created_by_peer_name`, a
// lifecycle `peer_name`, ...) but which the table does not list would pass a
// bound grant unchecked. So every registered method must be CLASSIFIED --
// either the paths it asserts, or an explicit empty list meaning "asserts
// none" -- and a method that is not classified fails closed under a binding.
//
// Pure: no dataset, no policy file, no route.

import { describe, expect, test } from "bun:test";
import { KNOWLEDGE_METHODS } from "../src/knowledge/registry";
import { PEER_FIELDS } from "../src/knowledge/registry.peerFields";
import { requireBoundPeers } from "../src/knowledge/transport";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return { code: (error as { code?: string }).code, path: (error as { path?: string }).path };
  }
  return "NO_THROW";
};

describe("registry.peerFields: every knowledge method is classified", () => {
  test("PEER_FIELDS names exactly the registered methods -- adding one forces a decision", () => {
    const registered = Object.keys(KNOWLEDGE_METHODS).sort();
    const classified = Object.keys(PEER_FIELDS).sort();
    expect(registered.filter((m) => !classified.includes(m))).toEqual([]);
    expect(classified.filter((m) => !registered.includes(m))).toEqual([]);
  });

  test("every classified path ends in a *peer_name field", () => {
    for (const [method, paths] of Object.entries(PEER_FIELDS)) {
      for (const path of paths) expect(`${method}:${path.at(-1)}`).toMatch(/:[a-z_]*peer_name$/);
    }
  });
});

describe("requireBoundPeers: an unclassified method fails closed under a binding", () => {
  const bound = { operator: false, peers: ["peer-a"] };
  const unbound = { operator: false, peers: null };

  test("bound: a method missing from the table is refused at the request root", () => {
    expect(codeOf(() => requireBoundPeers("notYetClassified", bytes({ peer_name: "peer-a" }), bound))).toEqual({
      code: "forbidden",
      path: "",
    });
  });

  test("unbound: nothing is consulted, classified or not", () => {
    expect(codeOf(() => requireBoundPeers("notYetClassified", bytes({ peer_name: "x" }), unbound))).toBe("NO_THROW");
  });

  test("a method classified as asserting none passes any body under a binding", () => {
    expect(codeOf(() => requireBoundPeers("getPeer", bytes({ workspace_name: "w", peer_name: "other" }), bound))).toBe(
      "NO_THROW",
    );
  });
});

// R7 (#28 part), docs/overnight/DECISIONS.md: "Caller-asserted attribution
// (created_by_peer_name, traces.peer_name) is checked against the R3 peers
// binding when one is configured." These five methods were exposed to
// transport by the #28/#31 expose-13 slice but never classified here, so
// EVERY call to them was refused outright (`forbidden` at the request root)
// under any bound grant -- fails closed, but not usefully: the binding
// should validate the asserted peer and let a bound caller through, not
// disable the method entirely. This describe block is scoped to the five
// methods THIS slice owns; getRecallEligibility, listLifecycleHistory,
// retireNode, supersedeNode (#29) and listSearchChunks,
// indexRevisionChunks, writeChunkEmbedding, reconcileSearchChunks (#30)
// are classified by their own dispatched slices -- until they land, the
// whole-registry equality test above stays red on THIS branch by design.
describe("#28: session-link and trace methods are classified and enforced", () => {
  const bound = { operator: false, peers: ["peer-a"] };
  const unbound = { operator: false, peers: null };

  test("createSessionLink asserts created_by_peer_name", () => {
    expect(PEER_FIELDS.createSessionLink).toEqual([["created_by_peer_name"]]);
  });
  test("createTrace asserts peer_name", () => {
    expect(PEER_FIELDS.createTrace).toEqual([["peer_name"]]);
  });
  test("getTrace, listTraceHits and listSessionLinks assert no acting peer", () => {
    expect(PEER_FIELDS.getTrace).toEqual([]);
    expect(PEER_FIELDS.listTraceHits).toEqual([]);
    expect(PEER_FIELDS.listSessionLinks).toEqual([]);
  });

  test("bound: createSessionLink with an UNLISTED created_by_peer_name is refused at its own pointer", () => {
    expect(
      codeOf(() =>
        requireBoundPeers(
          "createSessionLink",
          bytes({ id: "x", workspace_name: "w", from_session_name: "a", to_session_name: "b", relation: "continues", evidence_ref: null, created_by_peer_name: "peer-z" }),
          bound,
        ),
      ),
    ).toEqual({ code: "forbidden", path: "/created_by_peer_name" });
  });

  test("bound: createSessionLink with a LISTED created_by_peer_name passes, and so does a null one", () => {
    expect(
      codeOf(() =>
        requireBoundPeers(
          "createSessionLink",
          bytes({ id: "x", workspace_name: "w", from_session_name: "a", to_session_name: "b", relation: "continues", evidence_ref: null, created_by_peer_name: "peer-a" }),
          bound,
        ),
      ),
    ).toBe("NO_THROW");
    expect(
      codeOf(() =>
        requireBoundPeers(
          "createSessionLink",
          bytes({ id: "x", workspace_name: "w", from_session_name: "a", to_session_name: "b", relation: "continues", evidence_ref: null, created_by_peer_name: null }),
          bound,
        ),
      ),
    ).toBe("NO_THROW");
  });

  test("bound: createTrace with an UNLISTED peer_name is refused at its own pointer", () => {
    expect(
      codeOf(() => requireBoundPeers("createTrace", bytes({ workspace_name: "w", peer_name: "peer-z" }), bound)),
    ).toEqual({ code: "forbidden", path: "/peer_name" });
  });

  test("bound: createTrace with a LISTED peer_name passes", () => {
    expect(
      codeOf(() => requireBoundPeers("createTrace", bytes({ workspace_name: "w", peer_name: "peer-a" }), bound)),
    ).toBe("NO_THROW");
  });

  test("unbound: nothing is consulted for createSessionLink or createTrace either", () => {
    expect(
      codeOf(() => requireBoundPeers("createTrace", bytes({ workspace_name: "w", peer_name: "anyone" }), unbound)),
    ).toBe("NO_THROW");
    expect(
      codeOf(() =>
        requireBoundPeers("createSessionLink", bytes({ created_by_peer_name: "anyone" }), unbound),
      ),
    ).toBe("NO_THROW");
  });

  test("bound: getTrace, listTraceHits, listSessionLinks pass any body -- they assert no peer", () => {
    for (const method of ["getTrace", "listTraceHits", "listSessionLinks"]) {
      expect(codeOf(() => requireBoundPeers(method, bytes({ workspace_name: "w", id: "x" }), bound))).toBe("NO_THROW");
    }
  });
});
