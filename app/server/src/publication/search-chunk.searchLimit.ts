import type { Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import type { JcsValue } from "../contracts/jcs";

/** Hits returned when the request names no limit. */
export const DEFAULT_SEARCH_LIMIT = 10;
/** The most hits one search returns. Each hit is a NODE, not a chunk. */
export const MAX_SEARCH_LIMIT = 50;

/**
 * Optional hit count: absent or null is the default. A small JSON integer,
 * deliberately -- a decimal string here is a type error, as in every other
 * page-size field of this kernel (`parseListMessages`).
 */
export function searchLimit(value: JcsValue | undefined, tokens: Tokens): number {
  if (value === undefined || value === null) return DEFAULT_SEARCH_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value)) fail("invalid_type", tokens, "expected integer");
  if (value < 1 || value > MAX_SEARCH_LIMIT) fail("invalid_value", tokens, `expected 1..${MAX_SEARCH_LIMIT}`);
  return value;
}
