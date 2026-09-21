import { utf8ByteLength } from "./utf8-byte-length";
import type { JcsValue } from "./types";

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
