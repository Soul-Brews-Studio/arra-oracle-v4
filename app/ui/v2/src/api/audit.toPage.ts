import { type ApiResult } from "./client";
import { type Page } from "./listing";
import { asError } from "./memory";

/** A deliberate second copy of `listing.ts`'s private decoder rather than an
 *  export added over there -- that file belongs to another worktree this week,
 *  and a conflict in it would block two people instead of none. The rule it
 *  encodes is documented once, at `listing.ts`'s `isUnsupported`: from a
 *  LISTING route, `method_not_found` or a bare 404 means the method is absent,
 *  because a listing has no row identity that could legitimately be missing.
 *
 * Note what a failed request looks like coming out of here: empty rows, null
 * cursor, null total. The null CURSOR is why nothing downstream may read
 * `nextCursor === null` as "that was the whole set" -- see `countWithSample`,
 * which learned that the hard way. */
export function toPage<T>(result: ApiResult, cursorKey: string): Page<T> {
  if (!result.ok) {
    const absent = asError(result.body)?.code === "method_not_found" || result.status === 404;
    // `Page.error` (added alongside `listing.ts`'s own `toPage`, #33 fix-round):
    // this tier only ever feeds `useOverview`'s COUNTS, not a rendered row
    // list, so there is no "false empty page" UI defect to match here -- but
    // the shared `Page<T>` shape now requires the field, and a real failure
    // (401/403/5xx) is worth keeping distinguishable from "route absent" for
    // the same reason `listing.ts` does it, on the chance a future caller
    // reads more than `total` off this.
    return {
      rows: [],
      nextCursor: null,
      total: null,
      supported: !absent,
      error: absent ? null : (result.error ?? asError(result.body)?.code ?? `HTTP ${result.status}`),
    };
  }
  const body = result.body as Record<string, unknown>;
  return {
    rows: Array.isArray(body.rows) ? (body.rows as T[]) : [],
    nextCursor: typeof body[cursorKey] === "string" ? (body[cursorKey] as string) : null,
    total: typeof body.total === "string" ? body.total : null,
    supported: true,
    error: null,
  };
}
