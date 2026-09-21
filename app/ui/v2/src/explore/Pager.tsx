/** Prev/Next over a keyset cursor chain.
 *
 * Honcho's own Explore screenshot shows `« ‹ 1 / 9 › »` -- a jump-to-page
 * control. A keyset cursor cannot support that: there is no way to ask the
 * server for "page 7" directly, and no way to know the total PAGE count
 * without having walked every page first. Rendering `1 / 9` here would be
 * decoration that lies the moment it's clicked.
 *
 * What a keyset chain CAN honestly support: how many pages you have
 * personally walked so far (`pageIndex + 1`, labelled as a walk, not a
 * position among a known total), and how many rows you've seen versus the
 * server-reported `total`. That's what this renders instead.
 */
export function Pager({
  pageIndex,
  rowsShown,
  total,
  hasPrev,
  hasNext,
  loading,
  onPrev,
  onNext,
}: {
  pageIndex: number;
  rowsShown: number;
  total: string | null;
  hasPrev: boolean;
  hasNext: boolean;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-edge px-2 py-1.5 text-[11px] text-muted">
      <span>
        showing {rowsShown} {total !== null ? `of ${total}` : "so far -- total unknown"}
      </span>
      <span className="ml-1" title="pages walked in this browser, not a position among a known total">
        page {pageIndex + 1} (walked)
      </span>
      <div className="ml-auto flex gap-1">
        <button
          onClick={onPrev}
          disabled={!hasPrev || loading}
          className="rounded border border-edge px-1.5 py-0.5 hover:border-accent hover:text-accent disabled:opacity-30"
        >
          ‹ prev
        </button>
        <button
          onClick={onNext}
          disabled={!hasNext || loading}
          className="rounded border border-edge px-1.5 py-0.5 hover:border-accent hover:text-accent disabled:opacity-30"
        >
          next ›
        </button>
      </div>
    </div>
  );
}
