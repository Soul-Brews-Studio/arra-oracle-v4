/** Failing-first: #33 AC2/R12 (a11y slice) requirement 3. `bun test
 *  src/state/authErrorHint.test.ts`. */
import { describe, expect, test } from "bun:test";
import { authErrorHint } from "./authErrorHint";

describe("authErrorHint", () => {
  test("401 unauthenticated names the bad/missing token, not a generic refusal", () => {
    const hint = authErrorHint("unauthenticated");
    expect(hint).not.toBeNull();
    expect(hint).toMatch(/token/i);
  });

  test("403 forbidden names insufficient scope, distinctly from 401", () => {
    const hint = authErrorHint("forbidden");
    expect(hint).not.toBeNull();
    expect(hint).toMatch(/permission|scope/i);
    expect(hint).not.toBe(authErrorHint("unauthenticated"));
  });

  test("403 forbidden is also true for the R3 peer-binding refusal, not only token scope", () => {
    // #33 AC2 round 3: `transport.requireBoundPeers` answers the same governed
    // `forbidden` when the token is not BOUND to the peer the request names
    // -- the scope can be fine and the binding is the cause.
    const hint = authErrorHint("forbidden")!;
    expect(hint).toMatch(/bound|binding/i);
    expect(hint).toMatch(/peer/i);
  });

  test("any other code, or none, has no specific hint", () => {
    expect(authErrorHint("invalid_value")).toBeNull();
    expect(authErrorHint(null)).toBeNull();
    expect(authErrorHint(undefined)).toBeNull();
  });
});
