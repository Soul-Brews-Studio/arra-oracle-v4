import { METHODS, TIERS, type Method } from "../api/methods";
import { TierBadge } from "./TierBadge";
import { ActionBadge } from "./ActionBadge";

export function MethodList({
  selected,
  onSelect,
  filter,
  onFilter,
}: {
  selected: string;
  onSelect: (m: Method) => void;
  filter: string;
  onFilter: (v: string) => void;
}) {
  const shown = METHODS.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-edge bg-panel/30">
      <div className="border-b border-edge p-3">
        <input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="filter methods…"
          className="w-full rounded border border-edge bg-ink px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent"
        />
        <p className="mt-2 text-[11px] text-muted">
          {shown.length} of {METHODS.length} methods
        </p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {TIERS.map((tier) => {
          const group = shown.filter((m) => m.tier === tier);
          if (group.length === 0) return null;
          return (
            <div key={tier} className="py-1">
              <div className="px-3 py-1">
                <TierBadge tier={tier} />
              </div>
              {group.map((m) => (
                <button
                  key={m.name}
                  onClick={() => onSelect(m)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/10 ${
                    selected === m.name ? "bg-accent/15 text-accent" : "text-slate-200"
                  }`}
                >
                  <span className="flex-1 truncate font-mono">{m.name}</span>
                  <ActionBadge action={m.action} />
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
