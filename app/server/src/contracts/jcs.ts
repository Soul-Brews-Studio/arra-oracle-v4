/**
 * Strict JSON parsing and RFC 8785 (JCS) canonicalization — the one byte path.
 *
 * Why a hand-written parser: native `JSON.parse` silently keeps the LAST of
 * two duplicate keys and cannot report nesting depth, so anything built on it
 * has already lost the evidence the contract requires us to reject on. This
 * parser enforces duplicate DECODED keys, depth, and surrogate validity while
 * it walks the text, and returns objects as `Map`s so key order is explicit
 * and nothing inherits from `Object.prototype`.
 *
 * Numbers are ordinary IEEE-754 binary64 (I-JSON §2.2): decimals are fine,
 * integer literals past 2^53 round exactly as ECMAScript rounds them, and
 * anything needing exact arbitrary precision must be a string. Serialization
 * follows ECMAScript Number::toString, which is what JCS specifies; `-0`
 * becomes `0`.
 *
 * Contract: app/docs/contracts/revision-evidence-v1.md §2.
 */

import { ContractError, fail, pointer, reanchor } from "./errors";

export const LIMITS = Object.freeze({
  /** Per strict-parsed JSON document, in UTF-8 bytes. */
  maxDocumentBytes: 1 * 1024 * 1024,
  /** Root container = 1, each nested container +1, scalars add none. */
  maxDepth: 64,
  /** Whole batch request/response, in UTF-8 bytes (incl. optional final LF). */
  maxTransportBytes: 16 * 1024 * 1024,
  maxBatchItems: 64,
  maxStderrBytes: 64 * 1024,
  maxCorrelationIdBytes: 128,
});

export type JcsValue = null | boolean | number | string | JcsValue[] | JcsObject;
export type JcsObject = Map<string, JcsValue>;

const utf8 = new TextEncoder();
const utf8Fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8ByteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

/** Decode bytes as UTF-8, rejecting malformed sequences. Byte cap is checked FIRST. */
export function decodeUtf8Strict(bytes: Uint8Array, maxBytes: number, tokens: Array<string | number>): string {
  if (bytes.byteLength > maxBytes) {
    fail("limit_exceeded", tokens, `document is ${bytes.byteLength} bytes; limit ${maxBytes}`);
  }
  try {
    return utf8Fatal.decode(bytes);
  } catch {
    return fail("invalid_unicode", tokens, "malformed UTF-8");
  }
}

/** True when every surrogate code unit in `s` is part of a well-formed pair. */
export function hasOnlyPairedSurrogates(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Strict parser
// ---------------------------------------------------------------------------

/** Reports the RAW source span of a parsed value: UTF-8 byte length of the exact text it occupied. */
export type SpanSink = (path: Array<string | number>, rawBytes: number) => void;

class Parser {
  private pos = 0;
  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
    private readonly base: Array<string | number>,
    private readonly onSpan?: SpanSink,
  ) {}

  parseDocument(): JcsValue {
    this.skipWs();
    const value = this.parseValue(0, []);
    this.skipWs();
    if (this.pos !== this.text.length) {
      this.error("invalid_json", [], `trailing input at offset ${this.pos}`);
    }
    return value;
  }

  private error(code: "invalid_json" | "invalid_unicode" | "invalid_value" | "duplicate_key" | "limit_exceeded", rel: Array<string | number>, message: string): never {
    return fail(code, [...this.base, ...rel], message);
  }

  private skipWs(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else break;
    }
  }

  private parseValue(depth: number, rel: Array<string | number>): JcsValue {
    if (!this.onSpan) return this.parseValueInner(depth, rel);
    const start = this.pos;
    const value = this.parseValueInner(depth, rel);
    // The exact source text this value occupied, as UTF-8 bytes. Whitespace and
    // escape overhead INSIDE the value counts; surrounding whitespace does not.
    this.onSpan([...this.base, ...rel], utf8ByteLength(this.text.slice(start, this.pos)));
    return value;
  }

  private parseValueInner(depth: number, rel: Array<string | number>): JcsValue {
    if (this.pos >= this.text.length) this.error("invalid_json", rel, "unexpected end of input");
    const c = this.text[this.pos];
    switch (c) {
      case "{": return this.parseObject(depth + 1, rel);
      case "[": return this.parseArray(depth + 1, rel);
      case '"': return this.parseString(rel);
      case "t": return this.expectLiteral("true", true, rel);
      case "f": return this.expectLiteral("false", false, rel);
      case "n": return this.expectLiteral("null", null, rel);
      default:
        if (c === "-" || (c >= "0" && c <= "9")) return this.parseNumber(rel);
        return this.error("invalid_json", rel, `unexpected character ${JSON.stringify(c)} at offset ${this.pos}`);
    }
  }

  private expectLiteral<T extends JcsValue>(lit: string, value: T, rel: Array<string | number>): T {
    if (this.text.startsWith(lit, this.pos)) {
      this.pos += lit.length;
      return value;
    }
    return this.error("invalid_json", rel, `invalid literal at offset ${this.pos}`);
  }

  private checkDepth(depth: number, rel: Array<string | number>): void {
    if (depth > this.maxDepth) {
      this.error("limit_exceeded", rel, `nesting depth ${depth} exceeds ${this.maxDepth}`);
    }
  }

  private parseObject(depth: number, rel: Array<string | number>): JcsObject {
    this.checkDepth(depth, rel);
    this.pos++; // {
    const out: JcsObject = new Map();
    this.skipWs();
    if (this.text[this.pos] === "}") { this.pos++; return out; }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') this.error("invalid_json", rel, `expected string key at offset ${this.pos}`);
      const key = this.parseString(rel);
      if (out.has(key)) this.error("duplicate_key", [...rel, key], "duplicate decoded object key");
      this.skipWs();
      if (this.text[this.pos] !== ":") this.error("invalid_json", [...rel, key], `expected ':' at offset ${this.pos}`);
      this.pos++;
      this.skipWs();
      const value = this.parseValue(depth, [...rel, key]);
      out.set(key, value);
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ",") { this.pos++; continue; }
      if (c === "}") { this.pos++; return out; }
      this.error("invalid_json", rel, `expected ',' or '}' at offset ${this.pos}`);
    }
  }

  private parseArray(depth: number, rel: Array<string | number>): JcsValue[] {
    this.checkDepth(depth, rel);
    this.pos++; // [
    const out: JcsValue[] = [];
    this.skipWs();
    if (this.text[this.pos] === "]") { this.pos++; return out; }
    for (;;) {
      this.skipWs();
      out.push(this.parseValue(depth, [...rel, out.length]));
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ",") { this.pos++; continue; }
      if (c === "]") { this.pos++; return out; }
      this.error("invalid_json", rel, `expected ',' or ']' at offset ${this.pos}`);
    }
  }

  private parseString(rel: Array<string | number>): string {
    this.pos++; // opening quote
    let out = "";
    let start = this.pos;
    for (;;) {
      if (this.pos >= this.text.length) this.error("invalid_json", rel, "unterminated string");
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x22) { // "
        out += this.text.slice(start, this.pos);
        this.pos++;
        break;
      }
      if (c === 0x5c) { // backslash
        out += this.text.slice(start, this.pos);
        this.pos++;
        const e = this.text[this.pos++];
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = this.text.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.error("invalid_json", rel, `invalid \\u escape at offset ${this.pos}`);
            this.pos += 4;
            out += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          default:
            this.error("invalid_json", rel, `invalid escape at offset ${this.pos - 1}`);
        }
        start = this.pos;
        continue;
      }
      if (c < 0x20) this.error("invalid_json", rel, `raw control character U+${c.toString(16).padStart(4, "0")} in string`);
      this.pos++;
    }
    if (!hasOnlyPairedSurrogates(out)) this.error("invalid_unicode", rel, "unpaired surrogate in string");
    return out;
  }

  private parseNumber(rel: Array<string | number>): number {
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.pos));
    if (!m) this.error("invalid_json", rel, `invalid number at offset ${this.pos}`);
    // "01" matches "0" and leaves "1" behind; report THAT here, at the element, not
    // as a stray token at the enclosing container.
    const next = this.text.charCodeAt(this.pos + m[0].length);
    if (next >= 0x30 && next <= 0x39) this.error("invalid_json", rel, `leading zeros are not allowed at offset ${this.pos}`);
    this.pos += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) this.error("invalid_value", rel, `number ${m[0]} is not finite as binary64`);
    return n;
  }
}

/**
 * Parse strict JSON text. `tokens` is the JSON Pointer prefix errors are
 * reported under (the location of THIS document inside a larger payload).
 */
export function parseStrict(text: string, tokens: Array<string | number> = [], opts: { maxDepth?: number; maxBytes?: number; onSpan?: SpanSink } = {}): JcsValue {
  const maxBytes = opts.maxBytes ?? LIMITS.maxDocumentBytes;
  const size = utf8ByteLength(text);
  if (size > maxBytes) fail("limit_exceeded", tokens, `document is ${size} bytes; limit ${maxBytes}`);
  if (!hasOnlyPairedSurrogates(text)) fail("invalid_unicode", tokens, "unpaired surrogate in document");
  return new Parser(text, opts.maxDepth ?? LIMITS.maxDepth, tokens, opts.onSpan).parseDocument();
}

/** Parse strict JSON bytes: byte cap, then fatal UTF-8, then grammar. */
export function parseStrictBytes(bytes: Uint8Array, tokens: Array<string | number> = [], opts: { maxDepth?: number; maxBytes?: number; onSpan?: SpanSink } = {}): JcsValue {
  const text = decodeUtf8Strict(bytes, opts.maxBytes ?? LIMITS.maxDocumentBytes, tokens);
  return new Parser(text, opts.maxDepth ?? LIMITS.maxDepth, tokens, opts.onSpan).parseDocument();
}

/** Parse strict JSON text that MUST decode to an object. */
export function parseObjectText(text: string, tokens: Array<string | number>): JcsObject {
  const value = parseStrict(text, tokens);
  if (!(value instanceof Map)) fail("invalid_type", tokens, "JSON text must decode to an object");
  return value;
}

// ---------------------------------------------------------------------------
// Canonical serialization (RFC 8785)
// ---------------------------------------------------------------------------

/** ECMAScript Number::toString with JCS's -0 rule. Non-finite is a contract error. */
export function canonicalNumber(n: number, tokens: Array<string | number> = []): string {
  if (typeof n !== "number" || !Number.isFinite(n)) fail("invalid_value", tokens, "number must be finite");
  if (Object.is(n, -0)) return "0";
  return String(n);
}

/** JSON string per ECMAScript JSON.stringify — the escaping JCS mandates. */
export function canonicalString(s: string, tokens: Array<string | number> = []): string {
  if (!hasOnlyPairedSurrogates(s)) fail("invalid_unicode", tokens, "unpaired surrogate in string");
  return JSON.stringify(s);
}

/** UTF-16 code-unit order — what JS `<` on strings already does. Not code points. */
export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Serialize a parsed/constructed value as canonical JSON text. Objects MUST be
 * `Map`s: a plain object would let integer-like keys reorder themselves.
 */
export function canonicalize(value: JcsValue, tokens: Array<string | number> = [], depth = 0): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return canonicalNumber(value, tokens);
  if (typeof value === "string") return canonicalString(value, tokens);
  if (Array.isArray(value)) {
    if (depth + 1 > LIMITS.maxDepth) fail("limit_exceeded", tokens, `nesting depth ${depth + 1} exceeds ${LIMITS.maxDepth}`);
    return "[" + value.map((v, i) => canonicalize(v, [...tokens, i], depth + 1)).join(",") + "]";
  }
  if (value instanceof Map) {
    if (depth + 1 > LIMITS.maxDepth) fail("limit_exceeded", tokens, `nesting depth ${depth + 1} exceeds ${LIMITS.maxDepth}`);
    const keys = [...value.keys()].sort(compareUtf16);
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(canonicalString(k, tokens) + ":" + canonicalize(value.get(k) as JcsValue, [...tokens, k], depth + 1));
    }
    return "{" + parts.join(",") + "}";
  }
  return fail("invalid_type", tokens, `unsupported value type ${typeof value}`);
}

/** Canonical bytes: parse strictly, then serialize. */
export function canonicalizeText(text: string, tokens: Array<string | number> = []): string {
  return canonicalize(parseStrict(text, tokens), tokens);
}

export function canonicalBytes(value: JcsValue, tokens: Array<string | number> = []): Uint8Array {
  return utf8.encode(canonicalize(value, tokens));
}

/**
 * UTF-8 byte length a value WOULD have as compact JSON, computed without
 * building the string. Used to enforce the per-document bound on a payload
 * that arrived embedded in a larger (already parsed) transport document.
 */
export function jsonByteLength(value: JcsValue): number {
  if (value === null) return 4;
  if (value === true) return 4;
  if (value === false) return 5;
  if (typeof value === "number") return utf8ByteLength(Number.isFinite(value) ? String(value) : "null");
  if (typeof value === "string") return utf8ByteLength(JSON.stringify(value));
  if (Array.isArray(value)) {
    let n = 2 + Math.max(0, value.length - 1);
    for (const v of value) n += jsonByteLength(v);
    return n;
  }
  if (value instanceof Map) {
    let n = 2 + Math.max(0, value.size - 1);
    for (const [k, v] of value) n += utf8ByteLength(JSON.stringify(k)) + 1 + jsonByteLength(v);
    return n;
  }
  return 0;
}

/** Deep structural equality over JcsValues (numbers by SameValueZero, maps by key set + values). */
export function jcsEqual(a: JcsValue, b: JcsValue): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b || (Object.is(a, -0) && b === 0) || (Object.is(b, -0) && a === 0);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jcsEqual(v, b[i] as JcsValue));
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !jcsEqual(v, b.get(k) as JcsValue)) return false;
    }
    return true;
  }
  return false;
}

/** Build a Map from a plain literal — for constructing envelopes in code, never for parsing input. */
export function obj(entries: Record<string, JcsValue>): JcsObject {
  return new Map(Object.entries(entries));
}

export { ContractError, pointer, reanchor };
