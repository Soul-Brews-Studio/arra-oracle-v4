import { useState } from "react";
import type { ContextResult } from "../api/memory";
import { ContextItemRow } from "./ContextItemRow";
import { CoverageBadge } from "./CoverageBadge";
import { ExcludedList } from "./ExcludedList";

/**
 * The raw `getContext` view for the same peer+session the dialectic panel
 * asks about -- no model involved, so this is the reference for "did the
 * server assemble the evidence I expect" independent of whether a chat
 * model is even configured (see ModelNote).
 */
export function ContextPanel({
  context,
  loading,
  error,
  onRefresh,
}: {
  context: ContextResult | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">getContext</h2>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="ml-auto rounded border border-edge px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-accent disabled:opacity-40"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-300">{error}</p>}

      {!context && !loading && !error && (
        <p className="text-xs text-muted">No context loaded yet.</p>
      )}

      {context && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-100">{context.items.length} items</span>
            <CoverageBadge coverage={context.coverage} />
          </div>

          <ExcludedList excluded={context.excluded} omitted={context.excluded_omitted} />

          <div>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-accent hover:underline"
            >
              {expanded ? "Hide items" : `Show ${context.items.length} items`}
            </button>
            {expanded && (
              <ul className="mt-2 flex flex-col gap-2">
                {context.items.map((item) => (
                  <ContextItemRow key={item.public_id} item={item} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
