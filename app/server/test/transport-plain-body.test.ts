// #31 maint-audit (2026-09-27): `POST /api/memories` records its audit input
// as a plain copy of the strictly parsed body. That copy used to sit in a
// `try { ... } catch {}` whose fallback was dead -- the strict parser yields
// only null, booleans, finite numbers, strings, arrays and Maps, none of which
// `JSON.stringify` can throw on -- and, had it ever fired, the row would have
// recorded input `{}` and a null `session_name` with nothing to show the input
// was lost. The copy is now one function (`app.plainBody.ts`, shared with the
// MCP envelope reader) with no fallback at all; this pins what it returns and
// that the route no longer swallows anything.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseStrict } from "../src/contracts/jcs";
import { plainBody } from "../src/app.plainBody";

const parse = (text: string) => parseStrict(text, [], { maxDepth: 64 }) as Map<string, unknown>;

describe("plainBody: the audit copy of a strictly parsed body", () => {
  test("nested Maps become objects, arrays and key order are kept", () => {
    const body = parse('{"b":1,"a":{"y":[{"k":"v"},2,null],"x":true},"n":-0.5e3}');
    const plain = plainBody(body);
    expect(plain).toEqual({ b: 1, a: { y: [{ k: "v" }, 2, null], x: true }, n: -500 });
    expect(JSON.stringify(plain)).toBe('{"b":1,"a":{"y":[{"k":"v"},2,null],"x":true},"n":-500}');
  });

  test("a __proto__ key is copied as data, never as a prototype", () => {
    const plain = plainBody(parse('{"__proto__":{"polluted":true},"ok":1}'));
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect((plain as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(plain)).toEqual(["__proto__", "ok"]);
  });

  test("the copy is detached: deleting the scope carrier leaves the parsed body intact", () => {
    const body = parse('{"workspace_name":"w","name":"n"}');
    const plain = plainBody(body);
    delete plain.workspace_name;
    expect(plain).toEqual({ name: "n" });
    expect(body.get("workspace_name")).toBe("w");
  });
});

describe("plainBody never throws on a strictly parsed body, so no fallback is needed", () => {
  // The old inline copy, verbatim: the replacement must answer the same.
  const inline = (v: unknown) =>
    JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Map ? Object.fromEntries(x) : x)));

  test.each([
    ["Thai and emoji strings", '{"s":"\u0e44\u0e17\u0e22 \ud83d\ude00","t":"ไทย 😀"}'],
    ["keys JSON.stringify treats specially", '{"toJSON":{"a":1},"constructor":{"b":2},"valueOf":3}'],
    ["62-deep nesting", `{"x":${"[".repeat(62)}1${"]".repeat(62)}}`],
    ["extreme and signed numbers", '{"max":1e308,"z":-0,"tiny":5e-324,"neg":-1.5}'],
    ["an integer past 2^53", '{"big":123456789012345678901234}'],
    ["empty containers and null", '{"o":{},"a":[],"n":null,"f":false}'],
  ])("%s", (_name, text) => {
    const body = parse(text);
    expect(() => plainBody(body)).not.toThrow();
    expect(JSON.stringify(plainBody(body))).toBe(JSON.stringify(inline(body)));
  });
});

// Scoped to the one claim: the `POST /api/memories` audit input goes through
// `plainBody` with no swallowing `catch`. Other handlers are not this test's
// business.
test("POST /api/memories copies its audit input through plainBody, with no fallback", () => {
  const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  const from = source.indexOf('.post(\n      "/api/memories",');
  expect(from).toBeGreaterThanOrEqual(0);
  const rest = source.slice(from + 1);
  const handler = rest.slice(0, rest.search(/^\s+\.(post|get)\(/m));
  expect(handler).toContain("plainBody(document)");
  expect(handler).not.toMatch(/catch\s*\{\s*\}/);
});
