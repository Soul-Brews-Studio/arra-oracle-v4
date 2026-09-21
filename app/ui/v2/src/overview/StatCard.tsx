import type { Count } from "../api/overview";

/** One measured number, with enough beside it to be trusted.
 *
 * Two display rules, both learned the hard way against this server:
 *
 *  1. A count we could not obtain renders as an em dash, NEVER 0. Zero for
 *     "we did not ask" is a lie the reader will act on -- an empty-looking
 *     workspace reads as "nothing here" when the truth is "nothing asked".
 *     `explore/CountStrip.tsx` set this precedent; this card matches it.
 *  2. `value` stays a STRING all the way to the DOM. Int64 crosses this wire
 *     as a canonical decimal string, and parsing it would be the same silent
 *     precision bug `api/knowledge.ts` warns about for `position`. Nothing
 *     in this file calls Number().
 *
 * `tone` carries a distinction the digit cannot make on its own: a HEALTHY
 * zero and a MEANINGFUL zero look identical.
 *
 *   normal -- an ordinary count. 0 means "empty so far", and a write would
 *             change it.
 *   warn   -- really measured, but its meaning is not "no activity yet".
 *             `connections` has no writer anywhere in the codebase, and
 *             `mcp_calls` is written under ARRA_DATA_DIR while this read
 *             opens ARRA_KNOWLEDGE_DATASET_ROOT. Both stay 0 whatever the
 *             user does, so the card carries a glyph and `hint` must say
 *             why. Amber, not red: nothing is broken, the number is just
 *             answering a different question than the label suggests.
 *   good   -- a number that confirms something, e.g. a cross-check that
 *             agreed.
 *
 * `supported: false` is a FOURTH state and deliberately not another em dash.
 * `api/listing.ts` already separates "this build has no such method"
 * (method_not_found, or a bare 404 from an unregistered route) from "the
 * call failed", then throws the distinction away. Collapsing both into one
 * dash under-reports: a reader cannot tell "retry this" from "there is
 * nothing here to retry".
 */
export type StatTone = "normal" | "warn" | "good";

export type StatCardProps = {
  label: string;
  /** The server's own decimal string, or null for "not obtained". */
  value: string | null;
  tone?: StatTone;
  /** The tooltip, and where a caveat is obliged to live: for a null value the
   *  REASON, for a warn tone why the zero will not move. A card whose number
   *  needs a caveat is not finished until this says it. */
  hint: string;
  /** One line under the number: what it counts, or how it was derived. */
  sub?: string | null;
  /** The call that produced it -- `200 · 14 ms`. The panel's premise is that
   *  every number sits next to its own evidence. */
  meta?: string | null;
  supported?: boolean;
  /** Named in the tooltip when `supported` is false, so the reader knows
   *  which method this build is missing. */
  method?: string | null;
};

/** `CountOutcome` mapped onto this card ONCE, so no caller decides again what
 *  `failed` looks like. Translated by hand at four call sites, `failed`
 *  eventually renders as a 0 somewhere -- the single thing this page exists
 *  to prevent. `tone` stays the caller's job: whether a zero is meaningful is
 *  not knowable from the outcome. */
export function statFromCount(
  count: Count,
  status: number | null = null,
): Pick<StatCardProps, "value" | "hint" | "meta" | "supported" | "method"> {
  return {
    value: count.outcome === "counted" ? count.total : null,
    hint: count.note ?? `${count.method} · include_total: true`,
    meta: `${status ?? "—"} · ${count.durationMs} ms`,
    supported: count.outcome !== "absent",
    method: count.method,
  };
}

const VALUE_CLASS: Record<StatTone, string> = {
  normal: "text-slate-100",
  warn: "text-[#f0a35e]",
  good: "text-accent",
};

export function StatCard({
  label,
  value,
  tone = "normal",
  hint,
  sub = null,
  meta = null,
  supported = true,
  method = null,
}: StatCardProps) {
  // The raw wire value goes in the tooltip as well as the probe table, so any
  // number on this page can be traced back to what the server literally said
  // without scrolling somewhere else to find it.
  const title = supported
    ? [hint, value === null ? null : `server said "${value}"`].filter((part) => part !== null).join(" · ")
    : `${method ?? "this method"} is not registered on this server build — nothing to retry`;

  // An absent method makes the card RECEDE -- dashed border, flat background
  // -- rather than fade. Dimming it with opacity would drag the #8b93a7
  // caption below the contrast floor this project sets, and that caption is
  // the part saying there is nothing here to retry.
  return (
    <div title={title} className={`rounded border border-edge p-3 ${supported ? "bg-panel" : "border-dashed bg-ink"}`}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</span>
        {supported && tone === "warn" && <span className="text-[10px] text-[#f0a35e]">⚠</span>}
      </div>

      {supported ? (
        <p className={`mt-1 text-2xl font-semibold tabular-nums ${VALUE_CLASS[tone]}`}>{value ?? "—"}</p>
      ) : (
        <p className="mt-1 text-sm text-muted">not on this server</p>
      )}

      {sub !== null && <p className="mt-1 text-[11px] leading-snug text-muted">{sub}</p>}
      {meta !== null && <p className="mt-0.5 font-mono text-[10px] text-muted">{meta}</p>}
    </div>
  );
}
