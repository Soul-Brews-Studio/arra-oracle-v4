import type { ContextResult } from "../api/memory";

/**
 * `title` states the real rule because the obvious-sounding one is wrong:
 * seeing ANY `unauthorized` entry in `excluded` looks like missing data, but
 * it isn't -- it's `getContext` correctly refusing a peer's out-of-scope
 * item. Only a `budget_exceeded` exclusion (max_items or the wire-byte cap)
 * means an authorized candidate was actually left out. `coverage` already
 * encodes this server-side (service.getContext.ts's `budgetExceeded` flag);
 * this badge just has to not relabel it as a generic "warning".
 */
export function CoverageBadge({ coverage }: { coverage: ContextResult["coverage"] }) {
  const full = coverage === "full";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        full ? "border-accent/40 text-accent" : "border-[#f0a35e]/40 text-[#f0a35e]"
      }`}
      title={
        full
          ? "Every authorized candidate fit inside max_items and the wire budget."
          : "A budget or count bound stopped an authorized item from being included -- not caused by unauthorized exclusions alone."
      }
    >
      <span className={`h-1.5 w-1.5 rounded-full ${full ? "bg-accent" : "bg-[#f0a35e]"}`} />
      {full ? "full coverage" : "partial coverage"}
    </span>
  );
}
