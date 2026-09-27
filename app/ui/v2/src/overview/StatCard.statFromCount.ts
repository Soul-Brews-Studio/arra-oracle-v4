import type { Count } from "../api/overview";
import type { StatCardProps } from "./StatCard";

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
