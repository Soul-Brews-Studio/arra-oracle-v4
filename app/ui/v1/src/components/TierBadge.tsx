import type { Method } from "../api/methods";

const TONE: Record<Method["tier"], string> = {
  publication: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  taxonomy: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  context: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  evidence: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
};

export function TierBadge({ tier }: { tier: Method["tier"] }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ${TONE[tier]}`}>
      {tier}
    </span>
  );
}
