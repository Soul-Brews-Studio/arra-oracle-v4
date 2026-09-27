/** Failing-first test for the fix-round's blocking finding: a 401/403 on
 *  `listPeers`/`listSessions`/`listNodes` used to come back as
 *  `{rows:[], supported:true}` -- exactly the same shape as a genuinely
 *  empty page -- so `useListing` set `error: null` and the Explore view
 *  rendered "no peers / nothing on this page matches" over a server that
 *  never got to answer. `toPage`'s new `error` field must carry the real
 *  code separately from `supported`, which is reserved for "this route does
 *  not exist yet". `bun test src/api/listing.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Bank } from "./memory";
import { listNodes, listPeers, listSessions } from "./listing";

const bank: Bank = { bank: "b1", workspace: "w1", token: "wrong" };
const originalFetch = globalThis.fetch;

function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("api/listing distinguishes a real auth failure from an empty page", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("401 unauthenticated: supported stays true (the route exists), error carries the real code", async () => {
    stubFetch(401, { error: "unauthenticated" });
    const page = await listPeers(bank, null, 50, true);
    expect(page.rows).toEqual([]);
    expect(page.supported).toBe(true);
    expect(page.error).toBe("unauthenticated");
  });

  test("403 forbidden on listSessions reads the same way", async () => {
    stubFetch(403, { error: "forbidden" });
    const page = await listSessions(bank, null, 50, true);
    expect(page.supported).toBe(true);
    expect(page.error).toBe("forbidden");
  });

  test("403 forbidden on listNodes reads the same way", async () => {
    stubFetch(403, { error: "forbidden" });
    const page = await listNodes(bank, null, 50, true, null, false);
    expect(page.supported).toBe(true);
    expect(page.error).toBe("forbidden");
  });

  test("a genuinely unsupported endpoint (bare 404, pre-listing server) stays supported:false with no error text", async () => {
    stubFetch(404, { error: "error" });
    const page = await listPeers(bank, null, 50, true);
    expect(page.supported).toBe(false);
    expect(page.error).toBeNull();
  });

  test("method_not_found reads the same as a bare 404: unsupported, not an error", async () => {
    stubFetch(400, { error: { code: "method_not_found" } });
    const page = await listPeers(bank, null, 50, true);
    expect(page.supported).toBe(false);
    expect(page.error).toBeNull();
  });

  test("a real success still reports no error", async () => {
    stubFetch(200, { rows: [{ name: "p1", created_at: "now" }], next_after_name: null, total: "1" });
    const page = await listPeers(bank, null, 50, true);
    expect(page.error).toBeNull();
    expect(page.rows).toHaveLength(1);
  });
});

// ui-reads2 (r3 verifier finding 4): `toPage` threw on `body.rows` for a 200
// with a null body, so the caller never reached land(). It is a malformed
// answer, reported as one -- not a throw, and not an honest empty page.
describe("api/listing: a 2xx with no object body is a malformed answer", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("200 null on listPeers: no throw, no rows, an error naming it", async () => {
    stubFetch(200, null);
    const page = await listPeers(bank, null, 50, true);
    expect(page.rows).toEqual([]);
    expect(page.supported).toBe(true);
    expect(page.error).toBe("malformed listing response (no body)");
  });
});
