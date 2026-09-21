import type { Route } from "../state/useRoute";

type View = Route["view"];

/** Where to go next, and what you will actually find there.
 *
 * The blurbs name the mechanism rather than selling the screen, because the
 * mechanisms are the surprising part of this app: explore pages by keyset
 * cursor and therefore cannot jump to a page, and the forum is not a second
 * data set but the same messages redrawn along `in_reply_to`. A reader who
 * learns that here does not file it as a bug there.
 *
 * Navigation is a CALLBACK, never a hash write. `state/useRoute` owns the
 * URL, and App.tsx owns the single `push({ view })` that moves between
 * views; a second writer here would be a second place where a link can start
 * disagreeing with the screen.
 */
const CARDS: { view: View; title: string; blurb: string }[] = [
  { view: "explore", title: "explore", blurb: "peers, sessions and nodes — keyset paging, no page jump" },
  { view: "messages", title: "messages", blurb: "transcript · assembled context · dialectic answer" },
  { view: "forum", title: "forum", blurb: "the same messages, drawn as in_reply_to reply trees" },
  { view: "knowledge", title: "knowledge", blurb: "publish a revision · walk accepted history" },
];

export function QuickActions({
  onGo,
  details,
}: {
  onGo: (view: View) => void;
  /** Live one-liners from the page's own probes, e.g. "2 peers · 1 session ·
   *  5 nodes" under explore. A missing entry simply omits the line: unlike a
   *  count, an absent sentence claims nothing, so there is nothing here to
   *  render as an em dash. */
  details?: Partial<Record<View, string | null>>;
}) {
  return (
    <section className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-2">
      {CARDS.map((card) => {
        const detail = details?.[card.view] ?? null;
        return (
          <button
            key={card.view}
            onClick={() => onGo(card.view)}
            title={card.blurb}
            className="rounded border border-edge bg-panel p-3 text-left hover:border-accent/60"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">{card.title}</span>
            <p className="mt-1 text-[11px] leading-snug text-muted">{card.blurb}</p>
            {detail !== null && <p className="mt-1 text-[11px] text-slate-200">{detail}</p>}
          </button>
        );
      })}
    </section>
  );
}
