import type { Count } from "../api/overview";
import type { TypeCount } from "../api/typeCount";
import type { ByTypeCheck, HealthInfo } from "../state/overviewDerive";
import type { OverviewCounts } from "../state/useOverview";

/** The ledger under the cards: every request this page made, what it cost, and
 *  what came back.
 *
 * The premise of the screen is that a number is worth only as much as the call
 * behind it, so the calls are printed instead of implied -- a reader can match
 * each card to the method that produced it without guessing, and the page
 * states its own cost rather than hiding eleven requests behind five numbers.
 *
 * There is deliberately NO status column, though the design mock drew `200` on
 * every row. `api/listing.ts` discards the raw HTTP status when it folds a
 * response into `Page`, so every row here would print an em dash -- and a
 * column of dashes reads as a column of failures. A column that can only ever
 * say "unknown" misinforms more than an absent one.
 */
type ProbeRow = { key: string; method: string; durationMs: number; result: string; warn: boolean; title: string };

/** `CountOutcome` turned into words, in ONE place. Spelled out at each of the
 *  five call sites, `failed` would eventually be typed as `total "0"` in a row
 *  somebody copies -- the single confusion this page exists to prevent. */
function fromCount(count: Count): ProbeRow {
  const base = { key: count.method, method: count.method, durationMs: count.durationMs };
  if (count.outcome === "counted") {
    // The wire value in quotes because it IS text: Int64 crosses as a decimal
    // string, and the quotes are the reminder that nothing parsed it.
    return { ...base, result: `total "${count.total}"`, warn: false, title: `${count.method} · include_total: true` };
  }
  const result = count.outcome === "absent" ? "not on this server" : count.outcome === "failed" ? "no answer" : "not probed";
  return { ...base, result, warn: count.outcome === "failed", title: count.note ?? count.method };
}

/** The five per-type probes as one row, because they are one fan-out: five
 *  calls to the same method that differ only in `type_term`. Their combined
 *  wall time is what the page actually waited, and `Σ` is the row count they
 *  produced -- not a total, which a filtered list does not carry. */
function typeRow(byType: TypeCount[], check: ByTypeCheck): ProbeRow {
  const durationMs = byType.reduce((n, t) => n + t.durationMs, 0);
  // Three states, not two. With no total in a filtered response this row read
  // "Σ 0 rows" in ordinary muted text whether the fan-out came back empty or
  // never came back at all -- a total auth failure looked like an empty
  // workspace. `check.sum` is null in the second case, decided by the
  // unfiltered probe fired in the same volley.
  const counted =
    byType.length === 0
      ? "not probed"
      : check.sum === null
        ? "no answer — the unfiltered count failed too"
        : `no total † · Σ ${check.sum} rows${check.allExact ? "" : " (a floor)"}`;
  return {
    key: "listNodes-by-type",
    method: `listNodes ×${byType.length}`,
    durationMs,
    result: counted,
    warn: byType.length > 0 && (check.sum === null || !check.allExact),
    title: "listNodes with type_term set — one call per sealed type term",
  };
}

function healthRow(health: HealthInfo | null): ProbeRow {
  const base = { key: "health", method: "GET /health", durationMs: health?.durationMs ?? 0 };
  if (health === null) return { ...base, result: "not probed", warn: false, title: "the public liveness route" };
  return {
    ...base,
    result: health.ok ? `${health.version ?? "—"} · ${health.auth ?? "—"}` : "no answer",
    warn: !health.ok,
    title: health.ok
      ? "GET /health — public route, no bank and no token involved"
      : "GET /health did not answer: the server is unreachable, which is not a token problem",
  };
}

export function ProbeTable({
  counts,
  byType,
  byTypeCheck,
  health,
}: {
  counts: OverviewCounts;
  byType: TypeCount[];
  byTypeCheck: ByTypeCheck;
  health: HealthInfo | null;
}) {
  // Listed explicitly rather than through Object.values: the order on screen
  // should match the order of the cards above, and that is a decision here,
  // not an accident of how the state object was built.
  const rows: ProbeRow[] = [
    ...[counts.peers, counts.sessions, counts.nodes, counts.mcpCalls, counts.connections].map(fromCount),
    typeRow(byType, byTypeCheck),
    healthRow(health),
  ];

  return (
    <section className="rounded border border-edge bg-panel p-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-wide text-muted">
        probes · every number above, and its call
      </h2>
      <ul className="mt-2 flex flex-col gap-1">
        {rows.map((row) => (
          <li
            key={row.key}
            title={row.title}
            className="grid grid-cols-[minmax(7rem,1fr)_auto_minmax(9rem,1.4fr)] items-baseline gap-2 text-[11px]"
          >
            <span className="truncate font-mono text-slate-200">{row.method}</span>
            <span className="font-mono tabular-nums text-muted">{row.durationMs} ms</span>
            <span className={row.warn ? "text-[#f0a35e]" : "text-muted"}>{row.result}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10px] leading-snug text-muted">
        † a type-filtered listNodes answers with no total by design. No status column: the listing layer drops the raw
        HTTP status, and a dash on every row would read as seven failures.
      </p>
    </section>
  );
}
