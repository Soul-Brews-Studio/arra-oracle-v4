/** The `6 PEERS | 9 SESSIONS | 442 NODES` header strip from Honcho's Explore
 *  screen, plus one "refresh all" action.
 *
 * `total` is a canonical-decimal STRING per `api/listing.ts`, or `null` when
 * it was never requested or the server doesn't support it. Rendering `null`
 * as `0` would be a lie this UI would act on -- a workspace that looks empty
 * reads as "nothing to see here", not "we didn't ask" -- so the unknown case
 * gets an explicit em dash instead.
 */
export function CountStrip({
  peersTotal,
  sessionsTotal,
  nodesTotal,
  onRefreshAll,
  refreshing,
}: {
  peersTotal: string | null;
  sessionsTotal: string | null;
  nodesTotal: string | null;
  onRefreshAll: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="flex items-center gap-4 border-b border-edge px-4 py-2 text-xs">
      <Count label="peers" value={peersTotal} />
      <span className="text-edge">|</span>
      <Count label="sessions" value={sessionsTotal} />
      <span className="text-edge">|</span>
      <Count label="nodes" value={nodesTotal} />
      <button
        onClick={onRefreshAll}
        disabled={refreshing}
        className="ml-auto rounded border border-accent/40 px-2.5 py-1 font-medium text-accent hover:bg-accent/10 disabled:opacity-40"
      >
        {refreshing ? "refreshing…" : "refresh all"}
      </button>
    </div>
  );
}

function Count({ label, value }: { label: string; value: string | null }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-semibold text-slate-100" title={value === null ? "not counted yet" : value}>
        {value ?? "—"}
      </span>
      <span className="uppercase tracking-wide text-muted">{label}</span>
    </span>
  );
}
