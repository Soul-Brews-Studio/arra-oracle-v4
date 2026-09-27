import type React from "react";
/** The left rail's chrome: a collapse toggle and the rail itself.
 *
 * Collapsible because the three columns compete for one screen. At 1067px the
 * centre transcript had 443px between a 240px rail and a 384px panel -- the
 * column carrying the actual content was the narrowest one on the page.
 * Collapsing the rail to a 40px strip returns 200px to the transcript without
 * hiding anything permanently.
 *
 * The strip keeps the selected peer and session visible vertically, so a
 * collapsed rail still answers "who am I, and where" -- the two facts every
 * other panel's result depends on. A collapse that hid those would make the
 * rest of the screen ambiguous.
 */
export function SidebarShell({
  collapsed,
  onToggle,
  peer,
  session,
  children,
}: {
  collapsed: boolean;
  onToggle: () => void;
  peer: string | null;
  session: string | null;
  children: React.ReactNode;
}) {
  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-3 border-r border-edge py-2">
        <button
          onClick={onToggle}
          title="Expand peers and sessions"
          aria-label="Expand peers and sessions"
          aria-expanded={false}
          className="rounded border border-edge px-1.5 py-1 text-xs text-muted hover:border-accent hover:text-accent"
        >
          ›
        </button>
        <div className="flex flex-1 flex-col items-center gap-4 overflow-hidden">
          <Stripe label="peer" value={peer} />
          <Stripe label="session" value={session} />
        </div>
      </aside>
    );
  }
  return (
    <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-b border-edge p-3 md:w-60 md:border-b-0 md:border-r">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted">navigator</span>
        <button
          onClick={onToggle}
          title="Collapse to a strip"
          aria-label="Collapse to a strip"
          aria-expanded={true}
          className="rounded border border-edge px-1.5 text-xs text-muted hover:border-accent hover:text-accent"
        >
          ‹
        </button>
      </div>
      {children}
    </aside>
  );
}

/** Vertical text so a long name still fits a 40px strip without truncation
 *  games. `null` reads as an explicit em dash, never as an empty gap. */
function Stripe({ label, value }: { label: string; value: string | null }) {
  return (
    <div
      className="flex flex-col items-center gap-1 text-[10px]"
      style={{ writingMode: "vertical-rl" }}
      title={`${label}: ${value ?? "none selected"}`}
    >
      <span className="uppercase tracking-wide text-muted">{label}</span>
      <span className={value === null ? "text-muted" : "text-accent"}>{value ?? "—"}</span>
    </div>
  );
}
