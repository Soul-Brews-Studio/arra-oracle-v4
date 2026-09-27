import type { ContextItem } from "../api/memory";

/** One assembled-context item in `ContextPanel`: who said it, where, and the
 *  message text. Its own file so a render test can reach it -- the panel
 *  only shows items after a click. */
export function ContextItemRow({ item }: { item: ContextItem }) {
  return (
    <li className="rounded border border-edge bg-panel p-2">
      {/* #33 AC2 round 5: the same messages that wrap in the transcript
          overflowed here (the App aside scrolled sideways, 365/670 at 375). */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-muted">
        <span className="font-mono [overflow-wrap:anywhere]">{item.peer_name}</span>
        <span>·</span>
        <span className="font-mono [overflow-wrap:anywhere]">{item.session_name}</span>
        <span>·</span>
        <span>seq {item.seq_in_session}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-xs text-slate-100 [overflow-wrap:anywhere]">{item.content}</p>
    </li>
  );
}
