// #25 first slice: the pure policy parser/admitter, isolated from every route.
//
// Nothing here touches the filesystem, the clock, the network, the store or a
// real credential. Every secret is a synthetic literal from the fixture, whose
// digests were computed independently (Python hashlib) rather than by calling
// the module under test -- a golden the implementation cannot rubber-stamp.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseStrict } from "../src/contracts/jcs";
import { admit, parsePolicy } from "../src/auth/policy";
import F from "./fixtures/auth-policy-v1/known-answers.json";

const ALPHA = F.tokens.alpha;
const BETA = F.tokens.beta;
const GAMMA = F.tokens.gamma;
const UNKNOWN = F.tokens.unknown;
const T = F.times;

const bytes = (text: string) => new TextEncoder().encode(text);
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

const CAP = 256 * 1024;
/** The depth ceiling `parsePolicy` passes to the shared strict parser. */
const MAX_POLICY_DEPTH = 16;
/** A real JSON escape in the SOURCE text; decodes to the single character "a". */
const ESCAPED_NAME_SOURCE = "\\u0061lpha";
const DECODED_NAME = "alpha";
const json = (value: unknown) => bytes(JSON.stringify(value));

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? `NO_CODE:${String(error)}`;
  }
  return "NO_THROW";
};

/**
 * Return the thrown value, or fail the test if nothing was thrown. A sentinel
 * `throw` inside the caller's own `try` would be swallowed by its own `catch`
 * and silently turn "did not reject" into a confusing assertion on the sentinel.
 */
const caught = (fn: () => unknown): unknown => {
  let threw = false;
  let error: unknown;
  try {
    fn();
  } catch (e) {
    threw = true;
    error = e;
  }
  expect(threw).toBe(true);
  return error;
};

const workspace = (name: string, actions: string[]) => ({ name, actions });

const principal = (
  id: string,
  opts: { disabled?: boolean; workspaces?: unknown[]; global_actions?: string[] } = {},
) => ({
  id,
  disabled: opts.disabled ?? false,
  workspaces: opts.workspaces ?? [workspace("alpha", ["content:read"])],
  global_actions: opts.global_actions ?? [],
});

const credential = (
  id: string,
  principal_id: string,
  sha256: string,
  opts: { not_before?: string; expires_at?: string; revoked?: boolean } = {},
) => ({
  id,
  principal_id,
  sha256,
  not_before: opts.not_before ?? T.not_before,
  expires_at: opts.expires_at ?? T.expires_at,
  revoked: opts.revoked ?? false,
});

const policyDoc = (principals: unknown[], credentials: unknown[]) => ({
  version: "arra-auth/v1",
  principals,
  credentials,
});

/**
 * A SCHEMA-VALID policy document, hand-written as JSON source so it carries a
 * genuine `\uXXXX` escape, padded with real inter-token JSON whitespace to an
 * exact raw UTF-8 byte length.
 *
 * Hand-written rather than `JSON.stringify`d because stringify emits no escape
 * for an ordinary character, and the escape is the point: its 6 source bytes
 * decode to 1, so the raw document is provably larger than its compact form.
 * All characters are ASCII, so byte length equals string length.
 */
const capSizedPolicyText = (totalBytes: number): string => {
  const head = '{"version":"arra-auth/v1","principals":[{"id":"operator-a","disabled":false,';
  const mid =
    `"workspaces":[{"name":"${ESCAPED_NAME_SOURCE}","actions":["content:read"]}],"global_actions":[]}],`;
  const tail =
    `"credentials":[{"id":"credential-a","principal_id":"operator-a","sha256":"${ALPHA.sha256}",` +
    `"not_before":"${T.not_before}","expires_at":"${T.expires_at}","revoked":false}]}`;
  const body = head + mid + tail;
  const padding = totalBytes - body.length;
  if (padding < 3) throw new Error("requested size is smaller than the document itself");
  // Whitespace between two tokens is legal JSON and is counted as raw bytes.
  return `${head}${" ".repeat(padding)}${mid}${tail}`;
};

/** The canonical working policy: operator-a holds all four actions on `alpha`. */
const BASE_DOC = policyDoc(
  [
    principal("operator-a", {
      workspaces: [
        workspace("alpha", ["content:read", "content:write", "audit:read", "diagnostics:read"]),
      ],
      global_actions: [],
    }),
  ],
  [credential("credential-a", "operator-a", ALPHA.sha256)],
);

const basePolicy = () => parsePolicy(json(BASE_DOC));

const bearer = (secret: string) => `Bearer ${secret}`;

const wsTarget = (ws: string, action: string) => ({ kind: "workspace", workspace: ws, action });
const globalTarget = (action: string) => ({ kind: "global", action });

const input = (authorization: unknown, target: unknown, now_ms: unknown = T.inside_ms) =>
  ({ authorization, now_ms, target }) as never;

// ─────────────────────────────────────────────────────────────────────────────

describe("fixture integrity", () => {
  test("every synthetic digest is the real SHA-256 of its 64 ASCII token characters", () => {
    for (const [name, pair] of Object.entries(F.tokens)) {
      // Every token is 64 hex characters; only the deliberate uppercase variant
      // is not lowercase, and it exists precisely to prove grammar rejects it.
      expect(pair.secret).toMatch(/^[0-9a-fA-F]{64}$/);
      if (name !== "alpha_uppercase_variant") expect(pair.secret).toMatch(/^[0-9a-f]{64}$/);
      // Recomputed here from the literal secret; the fixture's stored value was
      // produced by Python, so agreement is cross-implementation, not circular.
      expect(createHash("sha256").update(pair.secret, "ascii").digest("hex")).toBe(pair.sha256);
    }
  });

  test("the fixture's epoch bounds are exactly the contract's Gregorian 0001-9999 range", () => {
    expect(F.clock_bounds.min_ms).toBe(-62135596800000);
    expect(F.clock_bounds.max_ms).toBe(253402300799999);
    expect(Date.parse(T.not_before)).toBe(T.not_before_ms);
    expect(Date.parse(T.expires_at)).toBe(T.expires_at_ms);
  });
});

describe("module surface", () => {
  test("exactly two runtime exports", async () => {
    const module = await import("../src/auth/policy");
    const runtime = Object.keys(module).filter(
      (key) => typeof (module as Record<string, unknown>)[key] !== "undefined",
    );
    expect(runtime.sort()).toEqual(["admit", "parsePolicy"]);
  });
});

describe("parsePolicy — raw input, byte cap and UTF-8", () => {
  test("a non-Uint8Array raw input is policy_invalid", () => {
    for (const bad of [null, undefined, "{}", 0, {}, [], new ArrayBuffer(2)]) {
      expect(codeOf(() => parsePolicy(bad as never))).toBe("policy_invalid");
    }
  });

  test("the 256 KiB cap: a SCHEMA-VALID document parses at exactly the cap and fails at cap+1", () => {
    // The earlier version of this test padded with an unknown `pad` key, so BOTH
    // sizes returned policy_invalid and the boundary was never demonstrated: the
    // at-cap case failed on the unknown key, not on passing the size gate.
    // Here the padded document is schema-VALID, so success at the cap is real
    // evidence that the gate admitted it, and only the extra byte rejects.
    const atCap = capSizedPolicyText(CAP);
    expect(utf8Bytes(atCap)).toBe(CAP);
    expect(() => parsePolicy(bytes(atCap))).not.toThrow();

    const overCap = capSizedPolicyText(CAP + 1);
    expect(utf8Bytes(overCap)).toBe(CAP + 1);
    expect(codeOf(() => parsePolicy(bytes(overCap)))).toBe("policy_invalid");
  });

  test("the at-cap document really does carry a JSON escape and real whitespace", () => {
    // Guards the fixture itself: if the escape or the padding silently vanished,
    // the cap test above would degrade into a plain-ASCII length check.
    const atCap = capSizedPolicyText(CAP);
    expect(atCap).toContain(ESCAPED_NAME_SOURCE); // a genuine \uXXXX escape
    expect(atCap).toContain("   "); // genuine inter-token JSON whitespace
    // The escape is 6 raw characters that decode to 1, so raw > compact here.
    expect(ESCAPED_NAME_SOURCE.length).toBeGreaterThan(DECODED_NAME.length);
  });

  test("the cap counts RAW bytes: a document whose COMPACT form fits is still rejected", () => {
    // Same policy, same decoded meaning, but padded past the cap. Re-encoding it
    // compactly would fit comfortably -- the gate must not measure that.
    const raw = capSizedPolicyText(CAP + 4096);
    expect(utf8Bytes(raw)).toBeGreaterThan(CAP);
    expect(codeOf(() => parsePolicy(bytes(raw)))).toBe("policy_invalid");
    // The compact form of the very same document is orders of magnitude smaller
    // and well under the cap, which is precisely why raw-vs-compact matters.
    expect(utf8Bytes(JSON.stringify(BASE_DOC))).toBeLessThan(CAP);
  });

  test("malformed UTF-8 bytes are policy_invalid and never decoded leniently", () => {
    for (const bad of [[0xff], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xe2, 0x28, 0xa1], [0xf0, 0x9f]]) {
      expect(codeOf(() => parsePolicy(new Uint8Array(bad)))).toBe("policy_invalid");
    }
  });

  test("invalid JSON and duplicate decoded keys are policy_invalid", () => {
    expect(codeOf(() => parsePolicy(bytes("{")))).toBe("policy_invalid");
    expect(codeOf(() => parsePolicy(bytes("")))).toBe("policy_invalid");
    expect(codeOf(() => parsePolicy(bytes('{"version":"arra-auth/v1","version":"arra-auth/v1"}')))).toBe(
      "policy_invalid",
    );
  });

  test("a deeply nested document is policy_invalid — but this does NOT locate the depth cap", () => {
    // Narrowed claim. A 20-deep array is rejected, however a 15-deep one is too,
    // because an array root fails the closed shape check regardless of depth.
    // The generic policy error cannot distinguish the two causes, so this test
    // asserts only the rejection. The cap itself is pinned below, on the parser.
    for (const depth of [15, 17, 20]) {
      let nested = "1";
      for (let i = 0; i < depth; i++) nested = `[${nested}]`;
      expect(codeOf(() => parsePolicy(bytes(nested)))).toBe("policy_invalid");
    }
  });
});

describe("depth cap — helper-level evidence, not a policy-level claim", () => {
  // WHY THIS LIVES ON THE HELPER: the closed policy schema bottoms out at depth
  // 6 (root > principals > principal > workspaces > workspace > actions), so no
  // schema-valid policy document can ever reach depth 16. The cap is therefore
  // unreachable through parsePolicy, and parsePolicy's single generic
  // `policy_invalid` could not tell a depth rejection from a shape rejection
  // anyway. Pinning it on the shared strict parser with the SAME maxDepth that
  // parsePolicy passes is the honest evidence available, and it is labelled as
  // helper evidence rather than dressed up as a policy-level guarantee.
  //
  // MEASURED LIMIT OF THIS EVIDENCE: `MAX_POLICY_DEPTH` below is declared here,
  // not imported from the module (which exports exactly two functions by
  // contract), so these tests CANNOT detect a change to policy.ts's own depth
  // constant -- verified by mutation: setting it to 17 leaves this suite green.
  // They pin the parser's behaviour at a stated depth; keeping the module in
  // step with that number is a review obligation, not something asserted here.
  const nest = (depth: number) => {
    let s = "1";
    for (let i = 0; i < depth; i++) s = `[${s}]`;
    return s;
  };

  test("the shared strict parser accepts depth 16 and rejects depth 17 at maxDepth 16", () => {
    expect(() => parseStrict(nest(16), [], { maxDepth: MAX_POLICY_DEPTH })).not.toThrow();
    expect(() => parseStrict(nest(17), [], { maxDepth: MAX_POLICY_DEPTH })).toThrow();
  });

  test("the deepest schema-valid policy is far shallower than the cap", () => {
    // Measured, not asserted from the prose: the illustrative document nests
    // root/principals/principal/workspaces/workspace/actions and no further.
    expect(() => parseStrict(JSON.stringify(BASE_DOC), [], { maxDepth: 6 })).not.toThrow();
    expect(MAX_POLICY_DEPTH).toBeGreaterThan(6);
  });
});

describe("parsePolicy — closed shapes", () => {
  test("the contract's illustrative document shape parses", () => {
    expect(() => basePolicy()).not.toThrow();
  });

  test("an empty deny-all policy is valid", () => {
    expect(() => parsePolicy(json(policyDoc([], [])))).not.toThrow();
  });

  test("every root key is required and extras reject", () => {
    for (const drop of ["version", "principals", "credentials"]) {
      const doc: Record<string, unknown> = { ...BASE_DOC };
      delete doc[drop];
      expect(codeOf(() => parsePolicy(json(doc)))).toBe("policy_invalid");
    }
    expect(codeOf(() => parsePolicy(json({ ...BASE_DOC, extra: 1 })))).toBe("policy_invalid");
  });

  test("a non-object root rejects", () => {
    for (const bad of ["[]", '"x"', "1", "null", "true"]) {
      expect(codeOf(() => parsePolicy(bytes(bad)))).toBe("policy_invalid");
    }
  });

  test("the version string is exact", () => {
    for (const bad of ["arra-auth/v2", "ARRA-AUTH/V1", "arra-auth/v1 ", "", null, 1]) {
      expect(codeOf(() => parsePolicy(json({ ...BASE_DOC, version: bad })))).toBe("policy_invalid");
    }
  });

  test("every principal key is required and extras reject", () => {
    for (const drop of ["id", "disabled", "workspaces", "global_actions"]) {
      const p: Record<string, unknown> = { ...principal("operator-a") };
      delete p[drop];
      expect(codeOf(() => parsePolicy(json(policyDoc([p], []))))).toBe("policy_invalid");
    }
    expect(
      codeOf(() => parsePolicy(json(policyDoc([{ ...principal("operator-a"), extra: 1 }], [])))),
    ).toBe("policy_invalid");
  });

  test("every credential key is required and extras reject", () => {
    const base = credential("credential-a", "operator-a", ALPHA.sha256);
    for (const drop of ["id", "principal_id", "sha256", "not_before", "expires_at", "revoked"]) {
      const c: Record<string, unknown> = { ...base };
      delete c[drop];
      expect(codeOf(() => parsePolicy(json(policyDoc([principal("operator-a")], [c]))))).toBe(
        "policy_invalid",
      );
    }
    expect(
      codeOf(() =>
        parsePolicy(json(policyDoc([principal("operator-a")], [{ ...base, extra: 1 }]))),
      ),
    ).toBe("policy_invalid");
  });

  test("every workspace entry key is required and extras reject", () => {
    for (const ws of [{ name: "alpha" }, { actions: ["content:read"] }, { name: "alpha", actions: ["content:read"], extra: 1 }]) {
      expect(
        codeOf(() => parsePolicy(json(policyDoc([principal("operator-a", { workspaces: [ws] })], [])))),
      ).toBe("policy_invalid");
    }
  });

  test("principals and credentials must be arrays", () => {
    expect(codeOf(() => parsePolicy(json({ ...BASE_DOC, principals: {} })))).toBe("policy_invalid");
    expect(codeOf(() => parsePolicy(json({ ...BASE_DOC, credentials: {} })))).toBe("policy_invalid");
  });
});

describe("parsePolicy — identifiers, names, actions, flags, times", () => {
  test("IDs match [A-Za-z0-9_-]{1,64} at boundary and boundary+1", () => {
    expect(() => parsePolicy(json(policyDoc([principal("a".repeat(64))], [])))).not.toThrow();
    expect(codeOf(() => parsePolicy(json(policyDoc([principal("a".repeat(65))], []))))).toBe(
      "policy_invalid",
    );
    for (const bad of ["", "has space", "has.dot", "has/slash", "ünicode", "tab\t"]) {
      expect(codeOf(() => parsePolicy(json(policyDoc([principal(bad)], []))))).toBe("policy_invalid");
    }
    for (const bad of [null, 1, true, [], {}]) {
      expect(
        codeOf(() => parsePolicy(json(policyDoc([{ ...principal("operator-a"), id: bad }], [])))),
      ).toBe("policy_invalid");
    }
  });

  test("workspace names are nonblank, <=256 UTF-8 bytes, and never trimmed or case folded", () => {
    const ok = (name: string) =>
      parsePolicy(json(policyDoc([principal("operator-a", { workspaces: [workspace(name, ["content:read"])] })], [])));
    expect(() => ok("a".repeat(256))).not.toThrow();
    expect(() => ok("ความทรงจำ")).not.toThrow();
    // Multi-byte: the cap is BYTES, not code units.
    const thai = "ก"; // 3 UTF-8 bytes
    expect(() => ok(thai.repeat(85))).not.toThrow(); // 255 bytes
    expect(codeOf(() => ok(thai.repeat(86)))).toBe("policy_invalid"); // 258 bytes
    expect(codeOf(() => ok("a".repeat(257)))).toBe("policy_invalid");
    for (const bad of ["", " ", "\t", "\n", "   "]) expect(codeOf(() => ok(bad))).toBe("policy_invalid");
    // A name that differs only by case or surrounding space is a DIFFERENT name,
    // so both may coexist -- proving no folding and no trimming happens.
    expect(() =>
      parsePolicy(
        json(
          policyDoc(
            [
              principal("operator-a", {
                workspaces: [
                  workspace("alpha", ["content:read"]),
                  workspace("Alpha", ["content:read"]),
                  workspace(" alpha", ["content:read"]),
                ],
              }),
            ],
            [],
          ),
        ),
      ),
    ).not.toThrow();
  });

  test("workspace actions are members of the closed section-2 set", () => {
    const ok = (actions: string[]) =>
      parsePolicy(json(policyDoc([principal("operator-a", { workspaces: [workspace("alpha", actions)] })], [])));
    expect(() => ok(["content:read", "content:write", "audit:read", "diagnostics:read"])).not.toThrow();
    expect(() => ok([])).not.toThrow();
    for (const bad of ["maintenance:backfill", "maintenance:reindex", "content:admin", "CONTENT:READ", "content:read "]) {
      expect(codeOf(() => ok([bad]))).toBe("policy_invalid");
    }
    expect(codeOf(() => ok([null as never]))).toBe("policy_invalid");
  });

  test("global actions are exactly the two maintenance grants, and neither implies the other", () => {
    const ok = (global_actions: string[]) =>
      parsePolicy(json(policyDoc([principal("operator-a", { global_actions })], [])));
    expect(() => ok([])).not.toThrow();
    expect(() => ok(["maintenance:backfill"])).not.toThrow();
    expect(() => ok(["maintenance:reindex"])).not.toThrow();
    expect(() => ok(["maintenance:backfill", "maintenance:reindex"])).not.toThrow();
    for (const bad of ["content:read", "maintenance:migrate", "maintenance:*", "MAINTENANCE:BACKFILL"]) {
      expect(codeOf(() => ok([bad]))).toBe("policy_invalid");
    }
  });

  test("flags are strictly boolean", () => {
    for (const bad of ["false", 0, 1, null, "", []]) {
      expect(
        codeOf(() => parsePolicy(json(policyDoc([{ ...principal("operator-a"), disabled: bad }], [])))),
      ).toBe("policy_invalid");
      expect(
        codeOf(() =>
          parsePolicy(
            json(
              policyDoc(
                [principal("operator-a")],
                [{ ...credential("credential-a", "operator-a", ALPHA.sha256), revoked: bad }],
              ),
            ),
          ),
        ),
      ).toBe("policy_invalid");
    }
  });

  test("the credential digest is exactly 64 lowercase hex characters", () => {
    const with256 = (sha256: unknown) =>
      parsePolicy(
        json(policyDoc([principal("operator-a")], [{ ...credential("c", "operator-a", ALPHA.sha256), sha256 }])),
      );
    expect(() => with256(ALPHA.sha256)).not.toThrow();
    for (const bad of [ALPHA.sha256.toUpperCase(), ALPHA.sha256.slice(0, 63), `${ALPHA.sha256}0`, "zz", "", null, 1]) {
      expect(codeOf(() => with256(bad))).toBe("policy_invalid");
    }
  });

  test("timestamps are canonical UTC millisecond strings inside Gregorian 0001-9999", () => {
    const withTimes = (not_before: unknown, expires_at: unknown) =>
      parsePolicy(
        json(
          policyDoc(
            [principal("operator-a")],
            [{ ...credential("c", "operator-a", ALPHA.sha256), not_before, expires_at }],
          ),
        ),
      );
    expect(() => withTimes("0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z")).not.toThrow();
    for (const bad of [
      "2026-09-20T00:00:00Z",
      "2026-09-20T00:00:00.000+00:00",
      "2026-09-20 00:00:00.000Z",
      "0000-01-01T00:00:00.000Z",
      "2026-13-01T00:00:00.000Z",
      "2026-02-30T00:00:00.000Z",
      1789862400000,
      null,
    ]) {
      expect(codeOf(() => withTimes(bad, T.expires_at))).toBe("policy_invalid");
    }
    // not_before < expires_at, strictly
    expect(codeOf(() => withTimes(T.expires_at, T.not_before))).toBe("policy_invalid");
    expect(codeOf(() => withTimes(T.not_before, T.not_before))).toBe("policy_invalid");
  });
});

describe("parsePolicy — collection limits at boundary and boundary+1", () => {
  const manyPrincipals = (n: number) =>
    Array.from({ length: n }, (_, i) => principal(`p${i}`, { workspaces: [] }));

  test("<=256 principals", () => {
    expect(() => parsePolicy(json(policyDoc(manyPrincipals(256), [])))).not.toThrow();
    expect(codeOf(() => parsePolicy(json(policyDoc(manyPrincipals(257), []))))).toBe("policy_invalid");
  });

  test("<=1024 credentials", () => {
    const creds = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        credential(`c${i}`, "operator-a", createHash("sha256").update(`synthetic-${i}`, "ascii").digest("hex")),
      );
    expect(() => parsePolicy(json(policyDoc([principal("operator-a")], creds(1024))))).not.toThrow();
    expect(codeOf(() => parsePolicy(json(policyDoc([principal("operator-a")], creds(1025)))))).toBe(
      "policy_invalid",
    );
  });

  test("<=256 workspace entries per principal", () => {
    const ws = (n: number) => Array.from({ length: n }, (_, i) => workspace(`w${i}`, ["content:read"]));
    expect(() =>
      parsePolicy(json(policyDoc([principal("operator-a", { workspaces: ws(256) })], []))),
    ).not.toThrow();
    expect(
      codeOf(() => parsePolicy(json(policyDoc([principal("operator-a", { workspaces: ws(257) })], [])))),
    ).toBe("policy_invalid");
  });
});

describe("parsePolicy — uniqueness and references", () => {
  test("principal IDs are unique", () => {
    expect(
      codeOf(() => parsePolicy(json(policyDoc([principal("dup"), principal("dup")], [])))),
    ).toBe("policy_invalid");
  });

  test("workspace names are unique within one principal", () => {
    expect(
      codeOf(() =>
        parsePolicy(
          json(
            policyDoc(
              [principal("operator-a", { workspaces: [workspace("alpha", ["content:read"]), workspace("alpha", ["audit:read"])] })],
              [],
            ),
          ),
        ),
      ),
    ).toBe("policy_invalid");
  });

  test("duplicate actions reject, for workspace and global sets alike", () => {
    expect(
      codeOf(() =>
        parsePolicy(
          json(policyDoc([principal("operator-a", { workspaces: [workspace("alpha", ["content:read", "content:read"])] })], [])),
        ),
      ),
    ).toBe("policy_invalid");
    expect(
      codeOf(() =>
        parsePolicy(
          json(policyDoc([principal("operator-a", { global_actions: ["maintenance:backfill", "maintenance:backfill"] })], [])),
        ),
      ),
    ).toBe("policy_invalid");
  });

  test("credential IDs and credential digests are each unique", () => {
    expect(
      codeOf(() =>
        parsePolicy(
          json(
            policyDoc(
              [principal("operator-a")],
              [credential("dup", "operator-a", ALPHA.sha256), credential("dup", "operator-a", BETA.sha256)],
            ),
          ),
        ),
      ),
    ).toBe("policy_invalid");
    expect(
      codeOf(() =>
        parsePolicy(
          json(
            policyDoc(
              [principal("operator-a")],
              [credential("c1", "operator-a", ALPHA.sha256), credential("c2", "operator-a", ALPHA.sha256)],
            ),
          ),
        ),
      ),
    ).toBe("policy_invalid");
  });

  test("every credential must reference a declared principal", () => {
    expect(
      codeOf(() =>
        parsePolicy(json(policyDoc([principal("operator-a")], [credential("c", "ghost", ALPHA.sha256)]))),
      ),
    ).toBe("policy_invalid");
  });
});

describe("the snapshot is opaque and immutable", () => {
  test("the handle exposes no policy data and is frozen", () => {
    const policy = basePolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.keys(policy as object)).toEqual([]);
    expect(JSON.stringify(policy)).toBe("{}");
    // No digest, principal or credential text is reachable from the handle.
    expect(JSON.stringify(policy)).not.toContain(ALPHA.sha256);
  });

  test("mutating the handle changes no admission outcome", () => {
    const policy = basePolicy();
    try {
      (policy as unknown as Record<string, unknown>).principals = [];
    } catch {
      // Frozen in strict mode: throwing is equally acceptable.
    }
    const out = admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read")));
    expect(out.principal_id).toBe("operator-a");
  });

  test("a forged, cloned or lookalike snapshot is invalid_request", () => {
    const real = basePolicy();
    const forgeries: unknown[] = [
      {},
      Object.freeze({}),
      { ...(real as object) },
      Object.create(Object.getPrototypeOf(real as object)),
      JSON.parse(JSON.stringify(real)),
      Object.assign(Object.create(null), real as object),
      null,
      undefined,
      "policy",
      7,
      [],
    ];
    for (const fake of forgeries) {
      expect(codeOf(() => admit(fake as never, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))))).toBe(
        "invalid_request",
      );
    }
  });

  test("two parses produce distinct handles and neither leaks into the other", () => {
    const a = parsePolicy(json(BASE_DOC));
    const b = parsePolicy(json(policyDoc([principal("operator-b", { workspaces: [workspace("beta", ["content:read"])] })], [credential("credential-b", "operator-b", BETA.sha256)])));
    expect(a).not.toBe(b);
    expect(admit(a, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))).principal_id).toBe("operator-a");
    expect(codeOf(() => admit(b, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))))).toBe(
      "unauthenticated",
    );
  });
});

describe("admit — trusted invocation shape and clock", () => {
  test("the input object is closed: missing, unknown or extra keys are invalid_request", () => {
    const policy = basePolicy();
    const good = { authorization: bearer(ALPHA.secret), now_ms: T.inside_ms, target: wsTarget("alpha", "content:read") };
    expect(() => admit(policy, good as never)).not.toThrow();
    for (const drop of ["authorization", "now_ms", "target"]) {
      const bad: Record<string, unknown> = { ...good };
      delete bad[drop];
      expect(codeOf(() => admit(policy, bad as never))).toBe("invalid_request");
    }
    expect(codeOf(() => admit(policy, { ...good, extra: 1 } as never))).toBe("invalid_request");
    for (const bad of [null, undefined, "x", 1, []]) {
      expect(codeOf(() => admit(policy, bad as never))).toBe("invalid_request");
    }
  });

  test("now_ms must be a safe integer inside the Gregorian range, at both bounds and just outside", () => {
    const policy = basePolicy();
    const at = (now_ms: unknown) => codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"), now_ms)));
    // In range but outside the credential window -> unauthenticated, i.e. the
    // CLOCK passed validation. That distinguishes a bad clock from a bad window.
    expect(at(F.clock_bounds.min_ms)).toBe("unauthenticated");
    expect(at(F.clock_bounds.max_ms)).toBe("unauthenticated");
    expect(at(F.clock_bounds.min_ms - 1)).toBe("invalid_request");
    expect(at(F.clock_bounds.max_ms + 1)).toBe("invalid_request");
    for (const bad of [1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2, "1789905600000", null, 10n]) {
      expect(at(bad)).toBe("invalid_request");
    }
  });

  test("the target is closed and its kind/action must be known", () => {
    const policy = basePolicy();
    const at = (target: unknown) => codeOf(() => admit(policy, input(bearer(ALPHA.secret), target)));
    expect(at({ kind: "workspace", workspace: "alpha" })).toBe("invalid_request");
    expect(at({ kind: "workspace", workspace: "alpha", action: "content:read", extra: 1 })).toBe("invalid_request");
    expect(at({ kind: "global", action: "maintenance:backfill", workspace: "alpha" })).toBe("invalid_request");
    expect(at({ kind: "elsewhere", action: "content:read" })).toBe("invalid_request");
    expect(at({ kind: "workspace", workspace: "alpha", action: "maintenance:backfill" })).toBe("invalid_request");
    expect(at({ kind: "global", action: "content:read" })).toBe("invalid_request");
    expect(at({ kind: "global", action: "maintenance:migrate" })).toBe("invalid_request");
    expect(at({ kind: "workspace", workspace: "", action: "content:read" })).toBe("invalid_request");
    expect(at({ kind: "workspace", workspace: "a".repeat(257), action: "content:read" })).toBe("invalid_request");
    for (const bad of [null, "workspace", 1, []]) expect(at(bad)).toBe("invalid_request");
  });

  test("an unknown or future global action never falls through to a grant", () => {
    const policy = parsePolicy(
      json(policyDoc([principal("operator-a", { global_actions: ["maintenance:backfill", "maintenance:reindex"] })], [credential("credential-a", "operator-a", ALPHA.sha256)])),
    );
    for (const action of ["maintenance:migrate", "maintenance:restore", "maintenance:*", "admin:all"]) {
      expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), globalTarget(action))))).toBe("invalid_request");
    }
  });

  test("getter-bearing and prototype-carried inputs are not honoured as own data properties", () => {
    const policy = basePolicy();
    const exotic = {
      get authorization() {
        return bearer(ALPHA.secret);
      },
      now_ms: T.inside_ms,
      target: wsTarget("alpha", "content:read"),
    };
    expect(codeOf(() => admit(policy, exotic as never))).toBe("invalid_request");
    const inherited = Object.create({ authorization: bearer(ALPHA.secret) });
    inherited.now_ms = T.inside_ms;
    inherited.target = wsTarget("alpha", "content:read");
    expect(codeOf(() => admit(policy, inherited as never))).toBe("invalid_request");
  });
});

describe("admit — header grammar", () => {
  const policy = basePolicy();
  const at = (authorization: unknown) =>
    codeOf(() => admit(policy, input(authorization, wsTarget("alpha", "content:read"))));

  test("a null or non-string authorization is unauthenticated, not invalid_request", () => {
    for (const bad of [null, 1, true, {}, [], undefined]) expect(at(bad)).toBe("unauthenticated");
  });

  test("the scheme is case-insensitive ASCII Bearer with exactly one space", () => {
    for (const good of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
      expect(() => admit(policy, input(`${good} ${ALPHA.secret}`, wsTarget("alpha", "content:read")))).not.toThrow();
    }
    for (const bad of [
      `Bearer  ${ALPHA.secret}`,
      `Bearer\t${ALPHA.secret}`,
      `Bearer${ALPHA.secret}`,
      ` Bearer ${ALPHA.secret}`,
      `Bearer ${ALPHA.secret} `,
      `Basic ${ALPHA.secret}`,
      `Bearer ${ALPHA.secret},Bearer ${BETA.secret}`,
      `Bearer ${ALPHA.secret} Bearer ${BETA.secret}`,
      ALPHA.secret,
      "Bearer",
      "Bearer ",
    ]) {
      expect(at(bad)).toBe("unauthenticated");
    }
  });

  test("the token is exactly 64 lowercase hex characters", () => {
    for (const bad of [
      ALPHA.secret.toUpperCase(),
      ALPHA.secret.slice(0, 63),
      `${ALPHA.secret}0`,
      ALPHA.secret.replace("0", "g"),
      "",
    ]) {
      expect(at(`Bearer ${bad}`)).toBe("unauthenticated");
    }
  });

  test("an UPPERCASE token is refused by grammar, even when its own digest is in the policy", () => {
    // Discriminating test: asserting `unauthenticated` on an uppercase token is
    // NOT enough on its own, because an uppercase token also misses the stored
    // lowercase digest -- both paths look identical from outside. So install a
    // policy whose digest IS sha256(UPPERCASE token). If grammar were relaxed to
    // accept uppercase hex, this would authenticate. It must not.
    const upper = F.tokens.alpha_uppercase_variant;
    expect(upper.secret).toBe(ALPHA.secret.toUpperCase());
    expect(upper.sha256).not.toBe(ALPHA.sha256);
    expect(createHash("sha256").update(upper.secret, "ascii").digest("hex")).toBe(upper.sha256);
    const policy = parsePolicy(
      json(
        policyDoc(
          [principal("operator-a", { workspaces: [workspace("alpha", ["content:read"])] })],
          [credential("credential-upper", "operator-a", upper.sha256)],
        ),
      ),
    );
    expect(codeOf(() => admit(policy, input(bearer(upper.secret), wsTarget("alpha", "content:read"))))).toBe(
      "unauthenticated",
    );
  });

  test("a syntactically invalid credential is indistinguishable from an unknown one", () => {
    expect(at("Bearer not-hex")).toBe("unauthenticated");
    expect(at(bearer(UNKNOWN.secret))).toBe("unauthenticated");
  });
});

describe("admit — authentication outcomes", () => {
  test("an unknown credential is unauthenticated", () => {
    expect(codeOf(() => admit(basePolicy(), input(bearer(UNKNOWN.secret), wsTarget("alpha", "content:read"))))).toBe(
      "unauthenticated",
    );
  });

  test("a revoked credential is unauthenticated", () => {
    const policy = parsePolicy(
      json(policyDoc([principal("operator-a")], [credential("credential-a", "operator-a", ALPHA.sha256, { revoked: true })])),
    );
    expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))))).toBe(
      "unauthenticated",
    );
  });

  test("a disabled principal is unauthenticated, even with a valid credential and a matching grant", () => {
    const policy = parsePolicy(
      json(policyDoc([principal("operator-a", { disabled: true })], [credential("credential-a", "operator-a", ALPHA.sha256)])),
    );
    expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))))).toBe(
      "unauthenticated",
    );
  });

  test("the time window is not_before <= now < expires_at, checked at exact edges", () => {
    const policy = basePolicy();
    const at = (now_ms: number) =>
      codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"), now_ms)));
    expect(at(T.not_before_ms - 1)).toBe("unauthenticated");
    expect(at(T.not_before_ms)).toBe("NO_THROW");
    expect(at(T.expires_at_ms - 1)).toBe("NO_THROW");
    expect(at(T.expires_at_ms)).toBe("unauthenticated");
    expect(at(T.expires_at_ms + 1)).toBe("unauthenticated");
  });
});

describe("admit — authorization outcomes", () => {
  test("an exact grant succeeds and returns only the contract's fields", () => {
    const out = admit(basePolicy(), input(bearer(ALPHA.secret), wsTarget("alpha", "content:read")));
    expect(Object.keys(out).sort()).toEqual(["credential_id", "policy_version", "principal_id", "target"]);
    expect(out.policy_version).toBe("arra-auth/v1");
    expect(out.principal_id).toBe("operator-a");
    expect(out.credential_id).toBe("credential-a");
    expect(out.target).toEqual({ kind: "workspace", workspace: "alpha", action: "content:read" });
  });

  test("the admission carries no secret, digest or peer identity", () => {
    const out = admit(basePolicy(), input(bearer(ALPHA.secret), wsTarget("alpha", "content:read")));
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(ALPHA.secret);
    expect(serialized).not.toContain(ALPHA.sha256);
    expect(serialized).not.toContain("peer");
    expect(serialized).not.toContain("sha256");
  });

  test("the admission and its nested target are deeply frozen and copied from the input", () => {
    const target = wsTarget("alpha", "content:read");
    const out = admit(basePolicy(), input(bearer(ALPHA.secret), target));
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.target)).toBe(true);
    expect(out.target).not.toBe(target);
    // Mutating the caller's target afterwards must not alter the admission.
    (target as Record<string, unknown>).workspace = "beta";
    // Narrow before reading `workspace`: the union's global arm has no such key.
    expect(out.target.kind).toBe("workspace");
    if (out.target.kind !== "workspace") throw new Error("expected a workspace target");
    expect(out.target.workspace).toBe("alpha");
  });

  test("a missing grant on an authenticated principal is forbidden, not unauthenticated", () => {
    const policy = parsePolicy(
      json(
        policyDoc(
          [principal("operator-a", { workspaces: [workspace("alpha", ["content:read"])] })],
          [credential("credential-a", "operator-a", ALPHA.sha256)],
        ),
      ),
    );
    expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:write"))))).toBe(
      "forbidden",
    );
    expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "audit:read"))))).toBe("forbidden");
  });

  test("content:write implies neither read, nor audit, nor diagnostics, nor any global action", () => {
    const policy = parsePolicy(
      json(
        policyDoc(
          [principal("operator-a", { workspaces: [workspace("alpha", ["content:write"])] })],
          [credential("credential-a", "operator-a", ALPHA.sha256)],
        ),
      ),
    );
    expect(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:write")))).not.toThrow();
    for (const action of ["content:read", "audit:read", "diagnostics:read"]) {
      expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", action))))).toBe("forbidden");
    }
    for (const action of ["maintenance:backfill", "maintenance:reindex"]) {
      expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), globalTarget(action))))).toBe("forbidden");
    }
  });

  test("the two maintenance grants are separate: neither implies the other", () => {
    const only = (grant: string) =>
      parsePolicy(
        json(policyDoc([principal("operator-a", { workspaces: [], global_actions: [grant] })], [credential("credential-a", "operator-a", ALPHA.sha256)])),
      );
    const backfill = only("maintenance:backfill");
    expect(() => admit(backfill, input(bearer(ALPHA.secret), globalTarget("maintenance:backfill")))).not.toThrow();
    expect(codeOf(() => admit(backfill, input(bearer(ALPHA.secret), globalTarget("maintenance:reindex"))))).toBe("forbidden");
    const reindex = only("maintenance:reindex");
    expect(() => admit(reindex, input(bearer(ALPHA.secret), globalTarget("maintenance:reindex")))).not.toThrow();
    expect(codeOf(() => admit(reindex, input(bearer(ALPHA.secret), globalTarget("maintenance:backfill"))))).toBe("forbidden");
  });

  test("a global grant does not authorize a workspace action, and vice versa", () => {
    const policy = parsePolicy(
      json(policyDoc([principal("operator-a", { workspaces: [], global_actions: ["maintenance:backfill"] })], [credential("credential-a", "operator-a", ALPHA.sha256)])),
    );
    expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))))).toBe("forbidden");
  });

  test("workspace matching is exact: case, spacing and prefixes never match", () => {
    const policy = basePolicy();
    for (const ws of ["Alpha", "ALPHA", " alpha", "alpha ", "alph", "alphax", "alpha/beta", "*"]) {
      expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget(ws, "content:read"))))).toBe("forbidden");
    }
  });

  test("an empty grant list is a working deny-all", () => {
    const policy = parsePolicy(
      json(policyDoc([principal("operator-a", { workspaces: [] })], [credential("credential-a", "operator-a", ALPHA.sha256)])),
    );
    expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))))).toBe("forbidden");
    expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), globalTarget("maintenance:backfill"))))).toBe("forbidden");
  });

  test("two principals across two workspaces stay separate — no permission union", () => {
    const policy = parsePolicy(
      json(
        policyDoc(
          [
            principal("operator-a", { workspaces: [workspace("alpha", ["content:read"])] }),
            principal("operator-b", { workspaces: [workspace("beta", ["content:write"])] }),
          ],
          [
            credential("credential-a", "operator-a", ALPHA.sha256),
            credential("credential-b", "operator-b", BETA.sha256),
          ],
        ),
      ),
    );
    expect(admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))).principal_id).toBe("operator-a");
    expect(admit(policy, input(bearer(BETA.secret), wsTarget("beta", "content:write"))).principal_id).toBe("operator-b");
    // A's credential cannot reach B's workspace, nor borrow B's action.
    expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("beta", "content:read"))))).toBe("forbidden");
    expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:write"))))).toBe("forbidden");
    expect(codeOf(() => admit(policy, input(bearer(BETA.secret), wsTarget("alpha", "content:read"))))).toBe("forbidden");
  });

  test("one principal holding two credentials reports the credential that actually matched", () => {
    const policy = parsePolicy(
      json(
        policyDoc(
          [principal("operator-a", { workspaces: [workspace("alpha", ["content:read"])] })],
          [
            credential("credential-a", "operator-a", ALPHA.sha256),
            credential("credential-g", "operator-a", GAMMA.sha256),
          ],
        ),
      ),
    );
    expect(admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))).credential_id).toBe("credential-a");
    expect(admit(policy, input(bearer(GAMMA.secret), wsTarget("alpha", "content:read"))).credential_id).toBe("credential-g");
  });

  test("revoking one credential does not disturb the principal's other credential", () => {
    const policy = parsePolicy(
      json(
        policyDoc(
          [principal("operator-a", { workspaces: [workspace("alpha", ["content:read"])] })],
          [
            credential("credential-a", "operator-a", ALPHA.sha256, { revoked: true }),
            credential("credential-g", "operator-a", GAMMA.sha256),
          ],
        ),
      ),
    );
    expect(codeOf(() => admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))))).toBe("unauthenticated");
    expect(admit(policy, input(bearer(GAMMA.secret), wsTarget("alpha", "content:read"))).credential_id).toBe("credential-g");
  });
});

describe("review repairs — accessors, Unicode, immutability, readonly code", () => {
  test("a `kind` getter is never invoked: the own-data boundary precedes any property read", () => {
    // Regression: `parseTarget` used to read `value.kind` directly, which RUNS a
    // getter -- caller code executing inside the authorization path, able to
    // throw its own error out of admit() instead of a closed one.
    let invoked = false;
    const target = Object.defineProperty({ workspace: "alpha", action: "content:read" }, "kind", {
      get() {
        invoked = true;
        throw new Error("SENTINEL_SECRET");
      },
      enumerable: true,
      configurable: true,
    });
    const error = caught(() => admit(basePolicy(), input(bearer(ALPHA.secret), target)));
    expect(invoked).toBe(false);
    expect((error as { code?: string }).code).toBe("invalid_request");
    expect((error as Error).message).not.toContain("SENTINEL_SECRET");
  });

  test("getters on any admission-input key are rejected without being invoked", () => {
    for (const key of ["authorization", "now_ms", "target"]) {
      let invoked = false;
      const base: Record<string, unknown> = {
        authorization: bearer(ALPHA.secret),
        now_ms: T.inside_ms,
        target: wsTarget("alpha", "content:read"),
      };
      delete base[key];
      Object.defineProperty(base, key, {
        get() {
          invoked = true;
          throw new Error("SENTINEL_SECRET");
        },
        enumerable: true,
        configurable: true,
      });
      const error = caught(() => admit(basePolicy(), base as never));
      expect(invoked).toBe(false);
      expect((error as { code?: string }).code).toBe("invalid_request");
    }
  });

  test("a lone surrogate workspace is invalid_request, decided before any credential work", () => {
    // Regression: this returned `forbidden`, which both misreports the failure
    // and implies the credential was examined against a malformed target.
    for (const bad of ["\ud800", "\udfff", "al\ud800pha", "alpha\udc00"]) {
      expect(codeOf(() => admit(basePolicy(), input(bearer(ALPHA.secret), wsTarget(bad, "content:read"))))).toBe(
        "invalid_request",
      );
    }
    // Even with NO credential presented, the malformed target still wins.
    expect(codeOf(() => admit(basePolicy(), input(null, wsTarget("\ud800", "content:read"))))).toBe(
      "invalid_request",
    );
  });

  test("a lone surrogate in a policy workspace name is policy_invalid, enforced by the strict parser", () => {
    // Measured: the strict parser rejects the `"\ud800"` ESCAPE form itself
    // with `invalid_unicode`, so no value-level check in this module is
    // reachable for it. The guarantee is real; the enforcer is the parser.
    const raw = bytes(
      '{"version":"arra-auth/v1","principals":[{"id":"p","disabled":false,"workspaces":[{"name":"\\ud800","actions":[]}],"global_actions":[]}],"credentials":[]}',
    );
    expect(codeOf(() => parsePolicy(raw))).toBe("policy_invalid");
  });

  test("the thrown code is non-writable at runtime, not merely readonly in TypeScript", () => {
    const error = caught(() => admit(basePolicy(), input(null, wsTarget("alpha", "content:read")))) as Error & {
      code?: string;
    };
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    try {
      (error as unknown as Record<string, unknown>).code = "forbidden";
    } catch {
      // Strict mode throws on the write; either way the value must not change.
    }
    expect(error.code).toBe("unauthenticated");
  });

  test("no admission outcome can be altered through the handle or a prior admission", () => {
    const policy = basePolicy();
    const before = admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read")));
    // Attempt to reach the backing data through every ordinary route.
    for (const key of ["principalsById", "credentials", "version", "principals"]) {
      expect((policy as unknown as Record<string, unknown>)[key]).toBeUndefined();
    }
    try {
      (before as unknown as Record<string, unknown>).principal_id = "operator-b";
    } catch {
      // Frozen: throwing is equally acceptable.
    }
    expect(before.principal_id).toBe("operator-a");
    const after = admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read")));
    expect(after.principal_id).toBe("operator-a");
    expect(after).toEqual(before);
  });
});

describe("errors are generic and secret-free", () => {
  test("every thrown failure is an Error carrying one closed code", () => {
    const closed = new Set(["policy_invalid", "invalid_request", "unauthenticated", "forbidden"]);
    const cases: Array<() => unknown> = [
      () => parsePolicy(bytes("{")),
      () => admit({} as never, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))),
      () => admit(basePolicy(), input(null, wsTarget("alpha", "content:read"))),
      // BASE_DOC grants all four actions, so a forbidden case needs a narrower policy.
      () =>
        admit(
          parsePolicy(
            json(
              policyDoc(
                [principal("operator-a", { workspaces: [workspace("alpha", ["content:read"])] })],
                [credential("credential-a", "operator-a", ALPHA.sha256)],
              ),
            ),
          ),
          input(bearer(ALPHA.secret), wsTarget("alpha", "content:write")),
        ),
    ];
    for (const run of cases) {
      const error = caught(run);
      expect(error).toBeInstanceOf(Error);
      const e = error as Error & { code?: string; cause?: unknown };
      expect(closed.has(e.code ?? "")).toBe(true);
      expect(e.cause).toBeUndefined();
    }
  });

  test("no message echoes a token, digest, workspace name or policy excerpt", () => {
    const secretish = [ALPHA.secret, ALPHA.sha256, "operator-a", "credential-a"];
    const runs: Array<() => unknown> = [
      () => parsePolicy(json({ ...BASE_DOC, version: "wrong-version-marker" })),
      () => parsePolicy(json(policyDoc([principal("operator-a")], [credential("c", "ghost-principal-marker", ALPHA.sha256)]))),
      () => admit(basePolicy(), input(bearer(ALPHA.secret), wsTarget("secret-workspace-marker", "content:read"))),
      () => admit(basePolicy(), input(bearer(UNKNOWN.secret), wsTarget("alpha", "content:read"))),
    ];
    for (const run of runs) {
      const message = (caught(run) as Error).message;
      for (const marker of ["wrong-version-marker", "ghost-principal-marker", "secret-workspace-marker", UNKNOWN.secret, ...secretish]) {
        expect(message).not.toContain(marker);
      }
    }
  });

  test("one code always yields one fixed message, regardless of which rule failed", () => {
    const messageFor = (fn: () => unknown) => (caught(fn) as Error).message;
    const a = messageFor(() => parsePolicy(bytes("{")));
    const b = messageFor(() => parsePolicy(json({ ...BASE_DOC, version: "arra-auth/v2" })));
    const c = messageFor(() => parsePolicy(new Uint8Array([0xff])));
    expect(a).toBe(b);
    expect(b).toBe(c);
    const d = messageFor(() => admit(basePolicy(), input(null, wsTarget("alpha", "content:read"))));
    const e = messageFor(() => admit(basePolicy(), input(bearer(UNKNOWN.secret), wsTarget("alpha", "content:read"))));
    expect(d).toBe(e);
    expect(d).not.toBe(a);
  });
});

describe("purity", () => {
  test("identical input yields identical output, and no clock is consulted for the window", () => {
    const policy = basePolicy();
    const first = admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"), T.not_before_ms));
    const second = admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"), T.not_before_ms));
    expect(first).toEqual(second);
    // The caller's now_ms alone decides the window: a value the real clock will
    // never return (year 0001) still admits when the credential window allows it.
    const wide = parsePolicy(
      json(
        policyDoc(
          [principal("operator-a", { workspaces: [workspace("alpha", ["content:read"])] })],
          [credential("credential-a", "operator-a", ALPHA.sha256, { not_before: "0001-01-01T00:00:00.000Z", expires_at: "9999-12-31T23:59:59.999Z" })],
        ),
      ),
    );
    expect(() => admit(wide, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"), F.clock_bounds.min_ms))).not.toThrow();
  });

  test("parsing the same bytes twice yields independent but equivalent snapshots", () => {
    const raw = json(BASE_DOC);
    const a = parsePolicy(raw);
    const b = parsePolicy(raw);
    expect(a).not.toBe(b);
    const outA = admit(a, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read")));
    const outB = admit(b, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read")));
    expect(outA).toEqual(outB);
  });

  test("parsePolicy does not retain or mutate the caller's buffer", () => {
    const raw = json(BASE_DOC);
    const copy = raw.slice();
    const policy = parsePolicy(raw);
    expect(raw).toEqual(copy);
    raw.fill(0);
    expect(admit(policy, input(bearer(ALPHA.secret), wsTarget("alpha", "content:read"))).principal_id).toBe("operator-a");
  });
});
