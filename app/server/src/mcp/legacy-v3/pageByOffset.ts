import type { Kb } from "./createKb";

/**
 * v3's `offset` over v4's keyset-only `listNodes` (V3-PARITY.md §4.3
 * oracle_list, §5 oracle_inbox): "offset is emulated by walking pages, at
 * most 10." `listNodes` has no offset of its own (a keyset cursor cannot
 * express one; MAX_PAGE_LIMIT bounds one page to 100 rows), so this walks
 * forward, discarding rows before `offset` and collecting `limit` after it,
 * across at most this many kernel calls -- the same bound V3-PARITY names.
 */
const MAX_OFFSET_PAGES = 10;
const MAX_PAGE_LIMIT = 100;

type ListNodesPage = {
  rows: Record<string, unknown>[];
  next_after_id: string | null;
  next_after_updated_at: string | null;
  total: string | null;
};

export type OffsetPage = {
  rows: Record<string, unknown>[];
  /** `listNodes`'s own `total`, taken from the FIRST page only -- it is a
   *  workspace-scoped count, unaffected by where the walk starts. `null`
   *  whenever the underlying filter has no native scoped count. */
  total: string | null;
  /** `true` when the walk hit `MAX_OFFSET_PAGES` before collecting `limit`
   *  rows past `offset` AND the workspace was not yet exhausted -- the
   *  caller names this in a `truncated` compat_warning (V3-PARITY.md §2.5). */
  truncated: boolean;
};

/**
 * `requestBase` is every `listNodes` key except the pagination ones this
 * function owns (`after_id`, `after_updated_at`, `limit`); the caller fills
 * `workspace_name`, `type_term`, `all_term_ids`/`any_term_ids`, `order` and
 * `include_inactive`/`include_total` as its own tool needs them.
 */
export async function pageByOffset(kb: Kb, requestBase: Record<string, unknown>, offset: number, limit: number): Promise<OffsetPage> {
  // `after_updated_at` is only ever a wire key under `order: "updated_desc"`
  // (`service.parseListNodes.ts`'s pairing rule) -- sending it, even `null`,
  // under the default order is `invalid_request`. Tracked as a plain boolean
  // rather than inferring from `undefined`-vs-`null`, so a caller that never
  // asked for `updated_desc` never risks the walk sending the key at all.
  const paired = requestBase.order === "updated_desc";
  let afterId: string | null = null;
  let afterUpdatedAt: string | null = null;
  let skipped = 0;
  const collected: Record<string, unknown>[] = [];
  let total: string | null = null;
  let exhausted = false;

  for (let page = 0; page < MAX_OFFSET_PAGES && collected.length < limit; page += 1) {
    const still = offset - skipped + (limit - collected.length);
    const pageLimit = Math.max(1, Math.min(MAX_PAGE_LIMIT, still));
    const payload: Record<string, unknown> = { ...requestBase, after_id: afterId, limit: pageLimit, include_total: page === 0 };
    if (paired) payload.after_updated_at = afterUpdatedAt;
    const result = (await kb("listNodes", payload)) as ListNodesPage;
    if (page === 0) total = result.total;

    for (const row of result.rows) {
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      if (collected.length < limit) collected.push(row);
    }

    if (result.next_after_id === null) {
      exhausted = true;
      break;
    }
    afterId = result.next_after_id;
    afterUpdatedAt = result.next_after_updated_at;
  }

  return { rows: collected, total, truncated: !exhausted && collected.length < limit };
}
