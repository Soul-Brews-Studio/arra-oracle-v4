import { useRef } from "react";
import { rovingKey } from "./rovingKey";

/** One WAI-ARIA tab strip (#33 AC2, ui-keys slice), shared by the app's view
 *  tabs and Explore's detail tabs so the two cannot drift apart.
 *
 *  - role=tablist (named by `label`), role=tab per entry, `aria-selected`
 *    on the active one, `aria-controls` naming the single panel the caller
 *    renders with `id={`${idBase}-panel`}` and
 *    `aria-labelledby={`${idBase}-tab-${active}`}`.
 *  - Roving tabindex: only the ACTIVE tab is a Tab stop (0); the rest are
 *    -1, reachable with the arrows. Tab from the strip goes on to the panel.
 *    An `active` that names no tab makes the first tab the stop.
 *  - Manual activation: ArrowLeft/ArrowRight/Home/End move focus only
 *    (`rovingKey`); Enter or Space on the focused tab activates it, through
 *    the native <button>. Arrowing across Explore's tabs therefore never
 *    pushes six history entries or fires six fetches on the way.
 *  Focus is visible through index.css's global `button:focus-visible` ring. */
export function TabStrip<T extends string>({
  label,
  idBase,
  tabs,
  active,
  onActivate,
  titles,
  className = "flex flex-wrap gap-1 border-b border-edge px-2 py-1.5",
  tabClassName = "rounded px-2.5 py-1 text-xs capitalize",
}: {
  label: string;
  idBase: string;
  tabs: readonly T[];
  active: T;
  onActivate: (t: T) => void;
  titles?: Partial<Record<T, string>>;
  className?: string;
  tabClassName?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Fix round (verifier, blocking): `active` is whatever the caller holds --
  // for Explore, a route string that may be a stale or hand-typed `tab`
  // ("Nodes"). With no tab matching it, every tab was tabindex=-1 and the
  // strip could not be reached with Tab at all. WAI-ARIA APG: when no tab is
  // selected, the FIRST tab is the tab stop.
  const stop = tabs.includes(active) ? active : tabs[0];
  return (
    <div role="tablist" aria-label={label} aria-orientation="horizontal" className={className}>
      {tabs.map((t, i) => {
        const selected = t === active;
        return (
          <button
            key={t}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel`}
            tabIndex={t === stop ? 0 : -1}
            title={titles?.[t]}
            onClick={() => onActivate(t)}
            onKeyDown={(e) => rovingKey(e, i, refs.current)}
            className={`${tabClassName} ${
              selected ? "bg-accent/15 text-accent" : "text-muted hover:text-slate-200"
            }`}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}
