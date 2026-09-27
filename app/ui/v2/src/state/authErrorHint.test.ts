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

  test("any other code, or none, has no specific hint", () => {
    expect(authErrorHint("invalid_value")).toBeNull();
    expect(authErrorHint(null)).toBeNull();
    expect(authErrorHint(undefined)).toBeNull();
  });
});
