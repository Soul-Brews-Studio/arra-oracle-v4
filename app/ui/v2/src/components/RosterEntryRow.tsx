import type { ReactNode } from "react";
import { StateDot } from "./StateDot";
import type { Entry } from "../state/roster";

/** One row, shared by PeerRail and SessionRail. The register action only
 *  shows for `missing` / `unknown` -- registering a `live` name is a no-op
 *  the server would just 409 on, so hiding it here saves a wasted round
 *  trip rather than hiding it as a courtesy. `extra` is a slot for the one
 *  action that isn't shared -- SessionRail's "join" -- so this file stays
 *  the single source of row layout instead of forking it. */
export function RosterEntryRow({
  entry,
  selected,
  onSelect,
  onRemove,
  onRegister,
  registerLabel,
  busy,
  extra,
}: {
  entry: Entry;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onRegister: () => void;
  registerLabel: string;
  busy: boolean;
  extra?: ReactNode;
}) {
  const canRegister = entry.state === "missing" || entry.state === "unknown";
  return (
    <div
      className={`group flex items-center gap-2 rounded px-2 py-1.5 text-xs ${
        selected ? "bg-accent/15 text-slate-100" : "text-slate-200 hover:bg-panel"
      }`}
    >
      {/* aria-current (ui-keys fix round, #33 AC2): the selected peer,
          session or node bookmark says so to a screen reader too, same as
          Explore's ListPanel rows. */}
      <button
        onClick={onSelect}
        aria-current={selected ? true : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <StateDot state={entry.state} />
        <span className="truncate">{entry.name}</span>
      </button>
      <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
        {extra}
        {canRegister && (
          <button
            onClick={onRegister}
            disabled={busy}
            className="rounded border border-accent/40 px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10 disabled:opacity-40"
          >
            {registerLabel}
          </button>
        )}
        <button
          onClick={onRemove}
          className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted hover:border-rose-500/40 hover:text-rose-300"
        >
          remove
        </button>
      </div>
    </div>
  );
}
