/** Failing-first test for #33 AC2/R12 (a11y slice): a live 401/403 never
 *  reads as a blank/generic "HTTP 401" when the server's OWN Host/Origin/
 *  bearer gate answers, because that gate's fixed bodies
 *  (`auth/http.ts:ERROR_BODIES`, e.g. `{"error":"unauthenticated"}` /
 *  `{"error":"forbidden"}`) are a bare STRING under `error`, not the
 *  `arra-error/v1` `{error:{code,...}}` object shape `asError` was written
 *  for. Before this fix, `asError` treats the string as an object, finds no
 *  `.code` on it, and returns null -- so `describe()` in `useMemory.ts` falls
 *  through to the generic `HTTP 401` / `HTTP 403` line instead of the actual
 *  refusal reason. Run with `bun test src/api/asError.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { asError } from "./memory";

describe("asError decodes the auth gate's flat {error: string} shape", () => {
  test("a 401 from the Host/Origin/bearer gate reads as 'unauthenticated', not null", () => {
    const envelope = asError({ error: "unauthenticated" });
    expect(envelope).not.toBeNull();
    expect(envelope!.code).toBe("unauthenticated");
  });

  test("a 403 from the same gate reads as 'forbidden', not null", () => {
    const envelope = asError({ error: "forbidden" });
    expect(envelope).not.toBeNull();
    expect(envelope!.code).toBe("forbidden");
  });

  test("the arra-error/v1 object shape still decodes exactly as before", () => {
    const envelope = asError({ error: { code: "invalid_value", pointer: "/max_items", message: "too big" } });
    expect(envelope).toEqual({ code: "invalid_value", pointer: "/max_items", message: "too big" });
  });

  test("a body with neither shape still reads as no envelope", () => {
    expect(asError({ ok: true })).toBeNull();
    expect(asError(null)).toBeNull();
    expect(asError("plain text")).toBeNull();
  });
});

// Fix-round finding (regression this slice introduced): the FIRST version of
// the fix above decoded ANY `{error: string}` body, not just the auth gate's
// two codes. `auth/http.ts`'s `ERROR_BODIES` answers the SAME flat shape for
// 400/413/415/503, and an unregistered route's bare 404 falls back to
// `{"error":"error"}`. Treating those as governed codes fed a spaced string
// ("bad request") to `chatError.ts`'s GOVERNED regex, which cannot match it,
// so a real 400 that DID reach the server was reported as "Could not reach
// the server" -- `chatError.test.ts` calls this exact wording "false, not
// just imprecise". `bun test src/api/asError.test.ts`.
describe("asError does NOT decode the gate's other flat bodies as governed codes", () => {
  test("400 bad request stays undecoded, so describe() falls back to HTTP 400", () => {
    expect(asError({ error: "bad request" })).toBeNull();
  });

  test("413 payload too large stays undecoded", () => {
    expect(asError({ error: "payload too large" })).toBeNull();
  });

  test("415 unsupported media type stays undecoded", () => {
    expect(asError({ error: "unsupported media type" })).toBeNull();
  });

  test("503 policy unavailable stays undecoded", () => {
    expect(asError({ error: "policy unavailable" })).toBeNull();
  });

  test("an unregistered route's bare 404 fallback ({error:\"error\"}) stays undecoded, so describe() reports HTTP 404", () => {
    expect(asError({ error: "error" })).toBeNull();
  });
});
