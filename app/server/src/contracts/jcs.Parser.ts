/**
 * Strict JSON parser internals. `Parser` is instantiated fresh per call by
 * both `parseStrict` and `parseStrictBytes` — it holds no state across
 * calls, so there is no shared-identity concern in splitting it out; it is
 * simply the one class both of those functions need.
 */

import { fail } from "./errors";
import { hasOnlyPairedSurrogates } from "./jcs.hasOnlyPairedSurrogates";
import type { JcsObject, JcsValue } from "./jcs.types";
import { utf8ByteLength } from "./jcs.utf8ByteLength";

/** Reports the RAW source span of a parsed value: UTF-8 byte length of the exact text it occupied. */
export type SpanSink = (path: Array<string | number>, rawBytes: number) => void;

export class Parser {
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
