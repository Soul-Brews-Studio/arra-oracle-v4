import { fail } from "../errors";
import { canonicalNumber } from "./canonical-number";
import { canonicalString } from "./canonical-string";
import { compareUtf16 } from "./compare-utf16";
import { LIMITS } from "./constants";
import type { JcsValue } from "./types";

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
