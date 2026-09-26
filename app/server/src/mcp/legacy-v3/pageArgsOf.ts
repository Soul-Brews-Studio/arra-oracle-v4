import { CompatError } from "./compat-error";

export type PageArgs = { limit: number; offset: number };

/** v3's `limit`/`offset` argument shape, shared by `oracle_list` and
 *  `oracle_inbox`: both optional, both plain non-negative integers -- v3
 *  input handling (V3-PARITY.md §3), not a domain rule any kernel enforces. */
export function pageArgsOf(tool: string, args: Record<string, unknown>, defaultLimit: number, maxLimit: number): PageArgs {
  const rawLimit = args.limit === undefined || args.limit === null ? defaultLimit : args.limit;
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > maxLimit) {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /limit", `limit must be an integer between 1 and ${maxLimit}`, { path: "/limit" });
  }
  const rawOffset = args.offset === undefined || args.offset === null ? 0 : args.offset;
  if (typeof rawOffset !== "number" || !Number.isInteger(rawOffset) || rawOffset < 0) {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /offset", "offset must be a non-negative integer", { path: "/offset" });
  }
  return { limit: rawLimit, offset: rawOffset };
}
