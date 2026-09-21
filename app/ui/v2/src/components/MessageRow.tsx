import type { MessageRow as MessageRowType } from "../api/memory";

/** `created_at` arrives as an ISO string; `Date` parses it fine for display,
 *  the STRING itself is what gets sent back anywhere it matters. Relative-ish
 *  because exact-to-the-second timestamps aren't the point of a transcript
 *  scan -- "how long ago" is. */
function relativeIsh(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const deltaS = Math.round((Date.now() - then) / 1000);
  if (deltaS < 60) return "just now";
  if (deltaS < 3600) return `${Math.round(deltaS / 60)}m ago`;
  if (deltaS < 86400) return `${Math.round(deltaS / 3600)}h ago`;
  return `${Math.round(deltaS / 86400)}d ago`;
}

export function MessageRow({
  message,
  highlighted,
}: {
  message: MessageRowType;
  highlighted: boolean;
}) {
  const isEmpty = message.content === "";
  return (
    <div
      className={`rounded border-l-2 bg-panel/40 px-3 py-2 ${
        highlighted ? "border-accent bg-accent/5" : "border-transparent"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-muted">
        <span className="font-semibold text-slate-100">{message.peer_name}</span>
        {message.role && <span>{message.role}</span>}
        <span className="font-mono">#{message.seq_in_session}</span>
        <span className="ml-auto">{relativeIsh(message.created_at)}</span>
      </div>
      {isEmpty ? (
        <p className="mt-1 text-xs italic text-muted">(empty content)</p>
      ) : (
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-100">{message.content}</p>
      )}
    </div>
  );
}
