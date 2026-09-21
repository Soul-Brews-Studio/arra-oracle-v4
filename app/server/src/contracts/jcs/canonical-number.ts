import { fail } from "../errors";

/** ECMAScript Number::toString with JCS's -0 rule. Non-finite is a contract error. */
export function canonicalNumber(n: number, tokens: Array<string | number> = []): string {
  if (typeof n !== "number" || !Number.isFinite(n)) fail("invalid_value", tokens, "number must be finite");
  if (Object.is(n, -0)) return "0";
  return String(n);
}
