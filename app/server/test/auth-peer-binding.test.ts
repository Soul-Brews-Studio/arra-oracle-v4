// #87 / R3 (docs/overnight/DECISIONS.md): the optional arra-auth/v1 `peers`
// binding on a workspace grant, and the pure lookup that reads it back.
//
// Pure: no file, clock, route or store. The binding is anti-spoofing only --
// when a grant lists `peers`, every peer name the caller asserts in a request
// must be one of them. It grants nothing and is inert when absent, so the
// frozen §7 surface (`parsePolicy`, `admit`, exact Admission shape) is
// unchanged; `peerBinding` lives beside the barrel, not in it.

import { describe, expect, test } from "bun:test";
import { admit, parsePolicy } from "../src/auth/policy";
import { peerBinding } from "../src/auth/policy.peerBinding";
import F from "./fixtures/auth-policy-v1/known-answers.json";

const ALPHA = F.tokens.alpha;
const BETA = F.tokens.beta;
const T = F.times;

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? `NO_CODE:${String(error)}`;
  }
  return "NO_THROW";
};

const credential = (id: string, principal_id: string, sha256: string) => ({
  id,
  principal_id,
  sha256,
  not_before: T.not_before,
  expires_at: T.expires_at,
  revoked: false,
});

const doc = (workspaces: unknown[], betaWorkspaces: unknown[] = [{ name: "alpha", actions: ["content:read"] }]) => ({
  version: "arra-auth/v1",
  principals: [
    { id: "agent-a", disabled: false, workspaces, global_actions: [] },
    { id: "operator-b", disabled: false, workspaces: betaWorkspaces, global_actions: ["maintenance:reindex"] },
  ],
  credentials: [credential("cred-a", "agent-a", ALPHA.sha256), credential("cred-b", "operator-b", BETA.sha256)],
});

const admitted = (policy: ReturnType<typeof parsePolicy>, secret: string, workspace: string, action = "content:read") =>
  admit(policy, {
    authorization: `Bearer ${secret}`,
    now_ms: T.inside_ms,
    target: { kind: "workspace", workspace, action },
  } as never);

describe("parsePolicy: the optional peers binding", () => {
  test("a grant may list peers; the binding is read back exactly, frozen, per workspace", () => {
    const policy = parsePolicy(
      json(
        doc([
          { name: "alpha", actions: ["content:read", "content:write"], peers: ["peer-a", "peer b", "ปีเตอร์"] },
          { name: "beta", actions: ["content:read"] },
        ]),
      ),
    );
    const onAlpha = peerBinding(policy, admitted(policy, ALPHA.secret, "alpha"));
    expect(onAlpha).toEqual(["peer-a", "peer b", "ปีเตอร์"]);
    expect(Object.isFrozen(onAlpha)).toBe(true);
    // The same principal's OTHER grant carries no binding: null, not [].
    expect(peerBinding(policy, admitted(policy, ALPHA.secret, "beta"))).toBeNull();
    // Another principal on the same workspace is unaffected.
    expect(peerBinding(policy, admitted(policy, BETA.secret, "alpha"))).toBeNull();
  });

  test("an empty list is a valid binding that permits asserting no peer at all", () => {
    const policy = parsePolicy(json(doc([{ name: "alpha", actions: ["content:read"], peers: [] }])));
    expect(peerBinding(policy, admitted(policy, ALPHA.secret, "alpha"))).toEqual([]);
  });

  test("the binding is identical whichever action admitted the request", () => {
    const policy = parsePolicy(
      json(doc([{ name: "alpha", actions: ["content:read", "audit:read"], peers: ["peer-a"] }])),
    );
    expect(peerBinding(policy, admitted(policy, ALPHA.secret, "alpha", "audit:read"))).toEqual(["peer-a"]);
  });

  test("the Admission itself is unchanged: exactly four keys, no peer identity", () => {
    const policy = parsePolicy(json(doc([{ name: "alpha", actions: ["content:read"], peers: ["peer-a"] }])));
    const admission = admitted(policy, ALPHA.secret, "alpha");
    expect(Object.keys(admission).sort()).toEqual(["credential_id", "policy_version", "principal_id", "target"]);
    expect(JSON.stringify(admission)).not.toContain("peer-a");
  });

  test("a malformed binding rejects the whole policy", () => {
    const bad: unknown[] = [
      null,
      "peer-a",
      {},
      [null],
      [7],
      [""],
      ["x".repeat(257)],
      ["peer-a", "peer-a"],
      Array.from({ length: 257 }, (_, i) => `peer-${i}`),
    ];
    for (const peers of bad) {
      expect(
        codeOf(() => parsePolicy(json(doc([{ name: "alpha", actions: ["content:read"], peers }])))),
        JSON.stringify(peers).slice(0, 40),
      ).toBe("policy_invalid");
    }
    // Boundaries that must pass: 256 UTF-8 bytes, and 256 entries.
    expect(() =>
      parsePolicy(json(doc([{ name: "alpha", actions: ["content:read"], peers: ["x".repeat(256)] }]))),
    ).not.toThrow();
    expect(() =>
      parsePolicy(
        json(doc([{ name: "alpha", actions: ["content:read"], peers: Array.from({ length: 256 }, (_, i) => `p${i}`) }])),
      ),
    ).not.toThrow();
    // The grant stays closed: `peers` is the only new key.
    expect(
      codeOf(() => parsePolicy(json(doc([{ name: "alpha", actions: ["content:read"], peer: ["peer-a"] }])))),
    ).toBe("policy_invalid");
  });
});

describe("peerBinding: a pure lookup, never a decision", () => {
  test("only a parser-made snapshot and a workspace admission are accepted", () => {
    const policy = parsePolicy(json(doc([{ name: "alpha", actions: ["content:read"], peers: ["peer-a"] }])));
    const admission = admitted(policy, ALPHA.secret, "alpha");
    expect(codeOf(() => peerBinding({} as never, admission))).toBe("invalid_request");
    expect(codeOf(() => peerBinding(JSON.parse(JSON.stringify(policy)), admission))).toBe("invalid_request");
    const global = admit(policy, {
      authorization: `Bearer ${BETA.secret}`,
      now_ms: T.inside_ms,
      target: { kind: "global", action: "maintenance:reindex" },
    } as never);
    expect(codeOf(() => peerBinding(policy, global))).toBe("invalid_request");
    // An admission this snapshot never produced names no grant it holds.
    expect(codeOf(() => peerBinding(policy, { ...admission, principal_id: "ghost" } as never))).toBe(
      "invalid_request",
    );
    expect(
      codeOf(() => peerBinding(policy, { ...admission, target: { kind: "workspace", workspace: "zeta", action: "content:read" } } as never)),
    ).toBe("invalid_request");
  });
});
