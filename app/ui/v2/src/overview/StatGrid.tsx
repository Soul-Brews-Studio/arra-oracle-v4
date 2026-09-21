import type { ReactNode } from "react";

/** The row of cards, wrapping instead of squeezing.
 *
 * `auto-fit` + `minmax` rather than a fixed `grid-cols-5`: five cards at a
 * fixed count turn a 900px window into five 150px columns where the number
 * fits and the "why it stays 0" caption does not -- and that caption is the
 * only thing stopping a measured zero from reading as "no activity". The
 * honest failure mode is fewer columns, never a truncated explanation.
 *
 * The column width lives in a literal class string because Tailwind extracts
 * classes statically; a width computed from a prop would compile to nothing.
 */
export function StatGrid({
  children,
  label = null,
  note = null,
}: {
  children: ReactNode;
  /** Optional section heading, e.g. the cross-check line above a breakdown. */
  label?: ReactNode;
  /** Optional footnote under the grid -- where a caveat about HOW the numbers
   *  were obtained belongs, since it applies to the whole row rather than to
   *  any single card's tooltip. */
  note?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      {label !== null && <div className="text-[11px] text-muted">{label}</div>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2">{children}</div>
      {note !== null && <p className="text-[11px] leading-snug text-muted">{note}</p>}
    </section>
  );
}
