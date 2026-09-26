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

// The 13 methods expose-13 put on the transports: the four that name an actor
// are checked against a binding like every other asserted peer, and the rest
// are reviewed as asserting none. Before the overnight merge classified them,
// a bound grant was refused all 13 outright (fail-closed, see above).
describe("expose-13 actors are bound like every other asserted peer", () => {
  const bound = { operator: false, peers: ["peer-a"] };
  const cases: [string, Record<string, unknown>, string][] = [
    ["createTrace", { workspace_name: "w", peer_name: "peer-b" }, "/peer_name"],
    ["createSessionLink", { workspace_name: "w", created_by_peer_name: "peer-b" }, "/created_by_peer_name"],
    ["retireNode", { workspace_name: "w", peer_name: "peer-b" }, "/peer_name"],
    ["supersedeNode", { workspace_name: "w", peer_name: "peer-b" }, "/peer_name"],
  ];
  for (const [method, body, path] of cases) {
    test(`${method}: an unbound actor is refused at ${path}; the bound one passes`, () => {
      expect(codeOf(() => requireBoundPeers(method, bytes(body), bound))).toEqual({ code: "forbidden", path });
      const own = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v === "peer-b" ? "peer-a" : v]));
      expect(codeOf(() => requireBoundPeers(method, bytes(own), bound))).toBe("NO_THROW");
    });
  }
  test("a trace read asserts no peer, so any body passes the binding", () => {
    expect(codeOf(() => requireBoundPeers("getTrace", bytes({ workspace_name: "w", peer_name: "peer-b" }), bound))).toBe(
      "NO_THROW",
    );
  });
});
