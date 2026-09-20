import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ContractError } from "../src/contracts/errors";
import { canonicalNumber, canonicalize, canonicalizeText, LIMITS, parseStrict, parseStrictBytes } from "../src/contracts/jcs";

const corpusPath = fileURLToPath(new URL("../../migrate-py/tests/fixtures/revision-v1/jcs-known-answers.json", import.meta.url));
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));

/** Reconstruct a binary64 from its big-endian hex bit pattern. Independent of the parser. */
function doubleFromHex(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt("0x" + hex), false);
  return view.getFloat64(0, false);
}

function expectError(fn: () => unknown, code: string, path: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    expect([(error as ContractError).code, (error as ContractError).path]).toEqual([code, path]);
    return;
  }
  throw new Error(`expected ${code} at ${JSON.stringify(path)}`);
}

test("RFC 8785 §3.2.3 example canonicalizes to the RFC's bytes", () => {
  const { input, expected } = corpus.rfc8785_section_3_2_3_example;
  expect(canonicalizeText(input)).toBe(expected);
});

test("RFC 8785 Appendix B ES6 number vectors serialize exactly", () => {
  for (const [hex, expected] of corpus.rfc8785_appendix_b_es6_numbers.vectors as [string, string][]) {
    expect([hex, canonicalNumber(doubleFromHex(hex))]).toEqual([hex, expected]);
  }
  for (const [hex, label] of corpus.rfc8785_appendix_b_es6_numbers.rejected as [string, string][]) {
    expect(() => canonicalNumber(doubleFromHex(hex))).toThrow(ContractError);
    expect(label).toMatch(/NaN|Infinity/);
  }
});

test("contract §2 examples: -0, exponent thresholds, integer-looking key order, duplicate decoded key", () => {
  for (const c of corpus.contract_section_2_examples) {
    if (c.error) expectError(() => canonicalizeText(c.input), c.error, c.path);
    else expect(canonicalizeText(c.input)).toBe(c.expected);
  }
});

test("keys sort by UTF-16 code units, not code points", () => {
  const { input, expected } = corpus.utf16_key_order;
  expect(canonicalizeText(input)).toBe(expected);
  // Proof that the two orders differ for this input: sort by code point and compare.
  const byCodePoint = [...(parseStrict(input) as Map<string, unknown>).keys()].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!);
  const byUtf16 = [...(parseStrict(input) as Map<string, unknown>).keys()].sort();
  expect(byCodePoint).not.toEqual(byUtf16);
});

test("Thai, emoji, controls and JSON specials escape per ECMAScript JSON.stringify", () => {
  const { input, expected } = corpus.thai_emoji_control_escaping;
  expect(canonicalizeText(input)).toBe(expected);
});

test("every negative in the corpus rejects with the stated code and pointer", () => {
  for (const n of corpus.negatives) {
    expectError(() => canonicalizeText(n.input), n.error, n.path);
  }
});

test("ordinary binary64 numbers are accepted and rounded; Int64 strings stay opaque", () => {
  for (const c of corpus.binary64_accepted.cases) {
    expect(canonicalizeText(c.input)).toBe(c.expected);
  }
  // A JSON string holding an integer past 2^53 is untouched -- exactness lives in strings.
  expect(canonicalizeText('"9007199254740993"')).toBe('"9007199254740993"');
});

test("depth 64 is the limit: root container is depth 1", () => {
  const nest = (n: number) => "[".repeat(n) + "]".repeat(n);
  expect(canonicalizeText(nest(64))).toBe(nest(64));
  expectError(() => parseStrict(nest(65)), "limit_exceeded", "/" + Array(64).fill("0").join("/"));
  // Objects count the same way.
  const objNest = (n: number) => '{"a":'.repeat(n) + "1" + "}".repeat(n);
  expect(canonicalizeText(objNest(64))).toBe(objNest(64));
  expect(() => parseStrict(objNest(65))).toThrow(ContractError);
});

test("per-document byte cap applies before parsing; bytes path rejects malformed UTF-8 after the cap", () => {
  const big = '"' + "x".repeat(LIMITS.maxDocumentBytes) + '"';
  expectError(() => parseStrict(big), "limit_exceeded", "");
  const bad = new Uint8Array([0x22, 0xff, 0xfe, 0x22]); // "\xff\xfe" inside quotes
  expectError(() => parseStrictBytes(bad), "invalid_unicode", "");
  const over = new Uint8Array(LIMITS.maxDocumentBytes + 1).fill(0x20);
  expectError(() => parseStrictBytes(over), "limit_exceeded", "");
});

test("a constructed Map with integer-looking keys serializes in lexical order, unlike a plain object", () => {
  const m = new Map<string, number>([["2", 1], ["10", 2], ["1", 3]]);
  expect(canonicalize(m)).toBe('{"1":3,"10":2,"2":1}');
  // The trap the contract names: JSON.stringify on a plain object reorders integer-like keys.
  expect(JSON.stringify({ "2": 1, "10": 2, "1": 3 })).toBe('{"1":3,"2":1,"10":2}');
});

test("non-finite constructed values throw before serialization instead of becoming null", () => {
  expect(() => canonicalize(NaN)).toThrow(ContractError);
  expect(() => canonicalize([1, Infinity])).toThrow(ContractError);
  expect(JSON.stringify(NaN)).toBe("null"); // what we refuse to do
});
