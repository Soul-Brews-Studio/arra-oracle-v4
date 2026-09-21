/** The `memory_horizon` term, badged, or nothing when absent -- horizon is
 *  optional (at most one, per `termSnapshots` in knowledge.ts). Rendered as
 *  a term rather than a column: issue #2 settled that memory age is a
 *  controlled vocabulary value here, deliberately not a boolean `is_active`
 *  tier, not a decay score, and not access-tracked. */
export function HorizonBadge({ horizon }: { horizon: string | null }) {
  if (horizon === null) return null;
  const isLong = horizon === "long_term";
  return (
    <span
      title="memory_horizon: a controlled vocabulary term, not a column or a decay score (issue #2)"
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
        isLong ? "border-accent/40 bg-accent/10 text-accent" : "border-edge bg-panel text-muted"
      }`}
    >
      {horizon}
    </span>
  );
}
