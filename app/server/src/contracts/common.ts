/**
 * Shared validators for the revision/evidence contract. Every function takes
 * a JSON Pointer token path and throws a closed `ContractError`; none of them
 * coerces. Values arrive as `JcsValue`s from the strict parser, so objects
 * are `Map`s.
 */

import { createHash } from "node:crypto";
import { fail, reanchor } from "./errors";
import { hasOnlyPairedSurrogates, type JcsObject, type JcsValue, utf8ByteLength } from "./jcs";
import { parseInt64, parseTimestamp } from "./v1";

export type Tokens = Array<string | number>;

export function isNanoid21(value: unknown): value is string {
  return typeof value === "string" && value.length === 21 && /^[A-Za-z0-9_-]{21}$/.test(value);
}

export function requireNanoid21(value: JcsValue, tokens: Tokens): string {
  if (!isNanoid21(value)) fail("invalid_value", tokens, "expected a 21-character URL-safe id");
  return value;
}

export function isLowercaseSha256Hex(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}

export function requireSha256Hex(value: JcsValue, tokens: Tokens): string {
  if (!isLowercaseSha256Hex(value)) fail("invalid_value", tokens, "expected 64 lowercase hex characters");
  return value;
}

export function requireUnicodeString(value: JcsValue, tokens: Tokens): string {
  if (typeof value !== "string") fail("invalid_type", tokens, "expected string");
  if (!hasOnlyPairedSurrogates(value)) fail("invalid_unicode", tokens, "unpaired surrogate");
  return value;
}

export function requireNonemptyString(value: JcsValue, tokens: Tokens): string {
  const s = requireUnicodeString(value, tokens);
  if (s.length === 0) fail("invalid_value", tokens, "must be nonempty");
  return s;
}

export function requireNullableString(value: JcsValue, tokens: Tokens): string | null {
  return value === null ? null : requireUnicodeString(value, tokens);
}

export function requireNullableNonemptyString(value: JcsValue, tokens: Tokens): string | null {
  return value === null ? null : requireNonemptyString(value, tokens);
}

export function requireBoolean(value: JcsValue, tokens: Tokens): boolean {
  if (typeof value !== "boolean") fail("invalid_type", tokens, "expected boolean");
  return value;
}

/** Canonical Int64 decimal text. Returns the validated string and its bigint. */
export function requireInt64String(value: JcsValue, tokens: Tokens): { text: string; value: bigint } {
  if (typeof value !== "string") fail("invalid_type", tokens, "int64 must be a canonical decimal string");
  try {
    return { text: value, value: parseInt64(value) };
  } catch (error) {
    return fail("invalid_value", tokens, (error as Error).message);
  }
}

export function requireNonNegativeInt64String(value: JcsValue, tokens: Tokens): { text: string; value: bigint } {
  const parsed = requireInt64String(value, tokens);
  if (parsed.value < 0n) fail("out_of_range", tokens, "must be >= 0");
  return parsed;
}

export function requirePositiveInt64String(value: JcsValue, tokens: Tokens): { text: string; value: bigint } {
  const parsed = requireInt64String(value, tokens);
  if (parsed.value <= 0n) fail("out_of_range", tokens, "must be > 0");
  return parsed;
}

/** Canonical public UTC-millisecond timestamp text; returns the original string. */
export function requireTimestampString(value: JcsValue, tokens: Tokens): string {
  if (typeof value !== "string") fail("invalid_type", tokens, "timestamp must be a string");
  try {
    parseTimestamp(value);
  } catch (error) {
    return fail("invalid_value", tokens, (error as Error).message);
  }
  return value;
}

export function requireNullableTimestampString(value: JcsValue, tokens: Tokens): string | null {
  return value === null ? null : requireTimestampString(value, tokens);
}

export function requireEnum<T extends string>(value: JcsValue, allowed: readonly T[], tokens: Tokens): T {
  if (typeof value !== "string") fail("invalid_type", tokens, "expected string");
  if (!(allowed as readonly string[]).includes(value)) fail("invalid_value", tokens, `expected one of ${allowed.join(", ")}`);
  return value as T;
}

/**
 * Require `value` to be an object with EXACTLY `keys`. Traversal is
 * deterministic: closed fields are checked in the documented order, and any
 * unknown keys are reported in sorted order. First error wins.
 */
export function requireClosedObject(value: JcsValue, keys: readonly string[], tokens: Tokens): JcsObject {
  if (!(value instanceof Map)) fail("invalid_type", tokens, "expected object");
  for (const k of keys) {
    if (!value.has(k)) fail("missing_field", [...tokens, k], `missing required key ${JSON.stringify(k)}`);
  }
  const extras = [...value.keys()].filter((k) => !keys.includes(k)).sort();
  if (extras.length > 0) fail("unexpected_field", [...tokens, extras[0]!], `unexpected key ${JSON.stringify(extras[0])}`);
  return value;
}

export function requireArray(value: JcsValue, tokens: Tokens): JcsValue[] {
  if (!Array.isArray(value)) fail("invalid_type", tokens, "expected array");
  return value;
}

export function sha256HexWithDomain(domain: string, bytes: Uint8Array | string): string {
  return createHash("sha256").update(domain, "utf8").update(bytes).digest("hex");
}

/** Exact byte cap for a raw JSON-valued column string. */
export function requireBoundedText(value: JcsValue, maxBytes: number, tokens: Tokens): string {
  const s = requireUnicodeString(value, tokens);
  const size = utf8ByteLength(s);
  if (size > maxBytes) fail("limit_exceeded", tokens, `text is ${size} bytes; limit ${maxBytes}`);
  return s;
}

export { reanchor };
