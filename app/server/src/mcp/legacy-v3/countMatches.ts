import type { Kb } from "./createKb";

const MAX_COUNT_PAGES = 10;
const PAGE_SIZE = 100;

export type MatchCount = { total: number; exhausted: boolean };

/**
 * An exact count of every `listNodes` row matching `requestBase`, for a
 * caller whose OWN v3 shape has a non-nullable `total` (`oracle_inbox`'s
 * `total:{type:"number"}`, unlike `oracle_list`'s, which is allowed `null`
 * with a `partial` warning). `listNodes`'s native `include_total` is `null`
 * whenever a term filter is active (K3), so this counts by walking instead --
 * bounded to `MAX_COUNT_PAGES` of `PAGE_SIZE`, the SAME "at most 10 kernel
 * pages" bound `pageByOffset` uses for its own walk. `exhausted: false` means
 * the true count is beyond that reach; the caller falls back to `null` with
 * its own `partial` warning rather than reporting a count that undercounts.
 */
export async function countMatches(kb: Kb, requestBase: Record<string, unknown>): Promise<MatchCount> {
  const paired = requestBase.order === "updated_desc";
  let afterId: string | null = null;
  let afterUpdatedAt: string | null = null;
  let total = 0;

  for (let page = 0; page < MAX_COUNT_PAGES; page += 1) {
    const payload: Record<string, unknown> = { ...requestBase, after_id: afterId, limit: PAGE_SIZE, include_total: false };
    if (paired) payload.after_updated_at = afterUpdatedAt;
    const result = (await kb("listNodes", payload)) as {
      rows: unknown[];
      next_after_id: string | null;
      next_after_updated_at: string | null;
    };
    total += result.rows.length;
    if (result.next_after_id === null) return { total, exhausted: true };
    afterId = result.next_after_id;
    afterUpdatedAt = result.next_after_updated_at;
  }
  return { total, exhausted: false };
}
