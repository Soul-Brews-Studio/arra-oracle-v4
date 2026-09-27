import { useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { Pager } from "./Pager";

/** One collapsible, filterable, paginated list box -- the shared shell
 *  behind both PEERS and SESSIONS in the left column. Generic over the row
 *  type so one file covers both instead of two near-duplicates.
 *
 * The filter box is a real trap if mislabelled: this contract has no
 * server-side search parameter for peers or sessions, only a cursor and a
 * limit. So the box filters the rows ALREADY LOADED on the current page,
 * nothing more -- it will not find a row sitting on page 4 while you're on
 * page 1. The placeholder says so; pretending otherwise would be the same
 * "total: 0 means unknown" lie this contract keeps warning about.
 */
export function ListPanel<T>({
  label,
  rows,
  rowKey,
  renderRow,
  selectedKey,
  onSelect,
  loading,
  error,
  supported,
  total,
  pageIndex,
  hasNext,
  hasPrev,
  onNext,
  onPrev,
  onRefresh,
}: {
  label: string;
  rows: T[];
  rowKey: (row: T) => string;
  renderRow: (row: T) => string;
  selectedKey: string | null;
  onSelect: (row: T) => void;
  loading: boolean;
  error: string | null;
  supported: boolean;
  total: string | null;
  pageIndex: number;
  hasNext: boolean;
  hasPrev: boolean;
  onNext: () => void;
  onPrev: () => void;
  onRefresh: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState("");
  const visible = filter === "" ? rows : rows.filter((r) => renderRow(r).toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex flex-col border-b border-edge">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          aria-expanded={!collapsed}
          className="text-muted hover:text-accent"
        >
          {collapsed ? "›" : "⌄"}
        </button>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</span>
        <button
          onClick={onRefresh}
          disabled={loading}
          title="refresh this list from page 1"
          aria-label={`Refresh ${label}`}
          className="ml-auto text-muted hover:text-accent disabled:opacity-40"
        >
          ↻
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="px-2 pb-1.5">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`filter loaded ${label}…`}
              title="filters rows already on this page only -- there is no server-side search here"
              aria-label={`Filter loaded ${label}`}
              className="w-full rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
            />
          </div>

          {!supported && (
            <p className="px-2 pb-2 text-[11px] text-[#f0a35e]">
              this server does not have listing endpoints yet
            </p>
          )}
          {/* polite `status`, not `alert`: a bad token errors every panel at
              once, and three assertive alerts with one sentence is noise; the
              one assertive alert is the transcript's (#33 AC2 round 4). */}
          {supported && error && <p role="status" className="px-2 pb-2 text-[11px] text-rose-300">{error}</p>}

          <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto px-1">
            {/* #33 fix-round: a 401/403 (or any other real failure) now
                carries a non-null `error` even though `supported` stays
                true -- the route exists, it just refused this request. An
                honest "no rows" only applies when there is no error to
                report; otherwise this rendered a false-empty workspace
                ("no peers / nothing on this page matches") over a server
                that never got to answer. */}
            {supported && !error && visible.length === 0 && !loading && (
              <EmptyState title={`no ${label}`} detail="nothing on this page matches." />
            )}
            {visible.map((row) => {
              const key = rowKey(row);
              return (
                <button
                  key={key}
                  onClick={() => onSelect(row)}
                  className={`truncate rounded px-2 py-1.5 text-left text-xs ${
                    selectedKey === key ? "bg-accent/15 text-slate-100" : "text-slate-200 hover:bg-panel"
                  }`}
                >
                  {renderRow(row)}
                </button>
              );
            })}
            {loading && <p className="px-2 py-1.5 text-xs text-muted">loading…</p>}
          </div>

          {supported && (
            <Pager
              pageIndex={pageIndex}
              rowsShown={rows.length}
              total={total}
              hasPrev={hasPrev}
              hasNext={hasNext}
              loading={loading}
              onPrev={onPrev}
              onNext={onNext}
            />
          )}
        </>
      )}
    </div>
  );
}
