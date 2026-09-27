/** Failing-first pure-helper test (#33 fix-round, blocking finding): the
 *  message a listing panel shows for one page must distinguish "this route
 *  does not exist" from "the route exists and refused me", and must give a
 *  401/403 its honest hint instead of `null`. `bun test
 *  src/state/listingErrorMessage.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { listingErrorMessage } from "./listingErrorMessage";

describe("listingErrorMessage", () => {
  test("unsupported (no listing endpoints) reads as the existing informational sentence", () => {
    expect(listingErrorMessage({ supported: false, error: null })).toBe(
      "this server does not have listing endpoints yet",
    );
  });

  test("supported with no error is a genuinely empty page: no message", () => {
    expect(listingErrorMessage({ supported: true, error: null })).toBeNull();
  });

  test("401 unauthenticated gets the honest token hint, not null", () => {
    const msg = listingErrorMessage({ supported: true, error: "unauthenticated" });
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/token/i);
  });

  test("403 forbidden gets the honest scope hint, distinct from 401", () => {
    const msg = listingErrorMessage({ supported: true, error: "forbidden" });
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/permission|scope/i);
    expect(msg).not.toBe(listingErrorMessage({ supported: true, error: "unauthenticated" }));
  });

  test("an unrecognized error code still surfaces something, not a swallowed null", () => {
    const msg = listingErrorMessage({ supported: true, error: "HTTP 500" });
    expect(msg).not.toBeNull();
    expect(msg).toContain("HTTP 500");
  });
});
