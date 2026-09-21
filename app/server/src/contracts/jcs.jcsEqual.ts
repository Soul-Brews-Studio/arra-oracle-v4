import type { JcsValue } from "./jcs.types";

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
