/** Status colour follows MEANING, not just 2xx/4xx:
 *  409 conflict and 503 recovery_required are distinct, real states here. */
export function StatusBadge({ status }: { status: number }) {
  const tone =
    status === 0
      ? "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30"
      : status < 300
        ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
        : status === 409
          ? "bg-amber-500/15 text-amber-300 ring-amber-500/30"
          : status === 503
            ? "bg-orange-500/15 text-orange-300 ring-orange-500/30"
            : status < 500
              ? "bg-yellow-500/15 text-yellow-300 ring-yellow-500/30"
              : "bg-rose-500/15 text-rose-300 ring-rose-500/30";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ring-1 ${tone}`}>
      {status === 0 ? "network" : status}
    </span>
  );
}
