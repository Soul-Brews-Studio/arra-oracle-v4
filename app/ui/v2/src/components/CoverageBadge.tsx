import type { ContextResult } from "../api/memory";
import { coverageBadge } from "../state/coverageBadge";

/**
 * `coverage` answers "is this everything?" (#85, overnight ruling R4):
 * `"full"` only when nothing was excluded for any reason. An unauthorized
 * omission counts, because the caller did not get the whole picture even if
 * access control was right to withhold it. The server derives this; the
 * MEANING (label, tone, explanation) lives in the pure `coverageBadge`
 * mapping so it can be pinned by a test without a DOM -- this component only
 * renders whatever that returns.
 */
export function CoverageBadge({ coverage }: { coverage: ContextResult["coverage"] }) {
  const view = coverageBadge(coverage);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        view.full ? "border-accent/40 text-accent" : "border-[#f0a35e]/40 text-[#f0a35e]"
      }`}
      title={view.title}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${view.full ? "bg-accent" : "bg-[#f0a35e]"}`} />
      {view.label}
    </span>
  );
}
