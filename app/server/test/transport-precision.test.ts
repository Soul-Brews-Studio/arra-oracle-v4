/**
 * #31 MCP transport -- precision lane.
 *
 * Boundary and representation exactness only, not lifecycle: `mcp-correctness.test.ts`
 * already proves the transport routes tools and redacts secrets end to end. This file
 * targets three load-bearing conversions in `src/mcp/protocol.ts` that a lifecycle test
 * would only ever exercise at one arbitrary value, never at their exact edges:
 *
 *   1. `text()`'s BigInt -> wire-number/string cutover at EXACTLY Number.MAX_SAFE_INTEGER
 *      and Number.MIN_SAFE_INTEGER (the existing suite proves a value two past the
 *      ceiling round-trips as a string -- it never proves where the line actually is,
 *      or that the negative side has one at all).
 *   2. `negotiate()`'s protocol-version echo, entirely untested anywhere in this repo
 *      (`rg -n "negotiate\\(" test/*.ts` before this file: zero hits).
 *   3. `ok()`/`err()` envelope exactness -- the EXACT key set a JSON-RPC caller can rely
 *      on, not a subset check that would still pass with extra leaked fields.
 *
 * Every assertion here was bite-tested: flipped to the wrong expectation, confirmed a
 * genuine failure, then restored. An assertion never observed failing is not evidence.
 */

import { describe, expect, test } from "bun:test";
import { KNOWN_PROTOCOL_VERSIONS, err, negotiate, ok, text } from "../src/mcp/protocol";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER); // 9007199254740991n
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER); // -9007199254740991n

function unwrap(block: ReturnType<typeof text>): unknown {
  const first = block.content[0];
  if (!first || first.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(first.text);
}

describe("text(): BigInt wire cutover, exactly at the safe-integer boundary", () => {
  test("MAX_SAFE_INTEGER itself survives as a JSON NUMBER", () => {
    const parsed = unwrap(text({ v: MAX_SAFE })) as { v: unknown };
    expect(parsed.v).toBe(Number.MAX_SAFE_INTEGER);
    expect(typeof parsed.v).toBe("number");
  });

  test("one past MAX_SAFE_INTEGER flips to a decimal STRING, exact digits", () => {
    const value = MAX_SAFE + 1n;
    const parsed = unwrap(text({ v: value })) as { v: unknown };
    expect(parsed.v).toBe("9007199254740992");
    expect(typeof parsed.v).toBe("string");
  });

  test("one BELOW MAX_SAFE_INTEGER stays a number (not an off-by-one on the wrong side)", () => {
    const parsed = unwrap(text({ v: MAX_SAFE - 1n })) as { v: unknown };
    expect(parsed.v).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(typeof parsed.v).toBe("number");
  });

  test("MIN_SAFE_INTEGER itself survives as a JSON number (negative side has a real boundary too)", () => {
    const parsed = unwrap(text({ v: MIN_SAFE })) as { v: unknown };
    expect(parsed.v).toBe(Number.MIN_SAFE_INTEGER);
    expect(typeof parsed.v).toBe("number");
  });

  test("one past MIN_SAFE_INTEGER (more negative) flips to a decimal STRING, exact digits and sign", () => {
    const value = MIN_SAFE - 1n;
    const parsed = unwrap(text({ v: value })) as { v: unknown };
    expect(parsed.v).toBe("-9007199254740992");
    expect(typeof parsed.v).toBe("string");
  });

  test("a large BigInt round-trips through JSON.parse's own bigint reviver path unchanged", () => {
    // Guards against a future refactor that stringifies via `String(v)` before
    // the safe-range check (which would silently damage nothing here, but a
    // check via Number(v) first WOULD lose precision) -- pin the full pipeline
    // output, not just the safe/unsafe branch outcome.
    const huge = 2n ** 100n;
    const parsed = unwrap(text({ v: huge })) as { v: unknown };
    expect(parsed.v).toBe(huge.toString(10));
    expect(BigInt(parsed.v as string)).toBe(huge);
  });
});

describe("negotiate(): protocol version echo is exact, never a silent substitution", () => {
  test("every KNOWN version is echoed back byte-for-byte, not merely accepted", () => {
    for (const v of KNOWN_PROTOCOL_VERSIONS) {
      expect(negotiate(v)).toBe(v);
    }
  });

  test("an unknown version falls back to the NEWEST known revision, not the oldest or a hard-coded one", () => {
    expect(negotiate("2099-01-01")).toBe(KNOWN_PROTOCOL_VERSIONS[0]);
    expect(negotiate("not-a-date")).toBe(KNOWN_PROTOCOL_VERSIONS[0]);
  });

  test("missing, null, and non-string protocolVersion all fall back rather than throwing or echoing garbage", () => {
    expect(negotiate(undefined)).toBe(KNOWN_PROTOCOL_VERSIONS[0]);
    expect(negotiate(null)).toBe(KNOWN_PROTOCOL_VERSIONS[0]);
    expect(negotiate(42)).toBe(KNOWN_PROTOCOL_VERSIONS[0]);
    // `String(42)` is "42", not one of the known versions -- confirms the
    // coercion doesn't accidentally match by number-to-string luck.
    expect(KNOWN_PROTOCOL_VERSIONS as readonly string[]).not.toContain("42");
  });

  test("a version string differing by ONE character is treated as fully unknown, not fuzzy-matched", () => {
    const almost = `${KNOWN_PROTOCOL_VERSIONS[0]!.slice(0, -1)}9`;
    expect(almost).not.toBe(KNOWN_PROTOCOL_VERSIONS[0]);
    expect(negotiate(almost)).toBe(KNOWN_PROTOCOL_VERSIONS[0]);
  });
});

describe("ok()/err(): JSON-RPC envelope has the EXACT key set, nothing leaked and nothing missing", () => {
  test("ok() is exactly {jsonrpc, id, result} -- three keys, no more", () => {
    const envelope = ok("req-1", { hello: "world" });
    expect(Object.keys(envelope).sort()).toEqual(["id", "jsonrpc", "result"]);
    expect(envelope.jsonrpc).toBe("2.0");
    expect(envelope.id).toBe("req-1");
    expect(envelope.result).toEqual({ hello: "world" });
  });

  test("err() is exactly {jsonrpc, id, error: {code, message}} -- no extra top-level or nested key", () => {
    const envelope = err("req-2", -32600, "Invalid Request");
    expect(Object.keys(envelope).sort()).toEqual(["error", "id", "jsonrpc"]);
    expect(Object.keys(envelope.error).sort()).toEqual(["code", "message"]);
    expect(envelope.error.code).toBe(-32600);
    expect(envelope.error.message).toBe("Invalid Request");
  });

  test("ok()/err() preserve id types the spec allows: string, number, and null", () => {
    expect(ok(1, {}).id).toBe(1);
    expect(ok(null, {}).id).toBeNull();
    expect(err("s", 1, "m").id).toBe("s");
  });
});
