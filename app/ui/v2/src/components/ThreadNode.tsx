import type { Thread } from "../forum/threads.buildThreads";

/** Same "how long ago" framing `MessageRow` uses -- exact timestamps aren't
 *  the point of scanning a thread, recency is. Duplicated rather than
 *  imported because `MessageRow.tsx` doesn't export it. */
function relativeIsh(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const deltaS = Math.round((Date.now() - then) / 1000);
  if (deltaS < 60) return "just now";
  if (deltaS < 3600) return `${Math.round(deltaS / 60)}m ago`;
  if (deltaS < 86400) return `${Math.round(deltaS / 3600)}h ago`;
  return `${Math.round(deltaS / 86400)}d ago`;
}

/** One node in the tree, plus its subtree. Indent is capped in pixels (not
 *  in the data) so a genuinely deep thread stays legible instead of walking
 *  the content off the right edge of the screen. */
export function ThreadNode({
  thread,
  highlighted,
  onReply,
  replyingTo,
}: {
  thread: Thread;
  highlighted: Set<string>;
  onReply: (publicId: string) => void;
  replyingTo: string | null;
}) {
  const { root, replies, depth, orphaned } = thread;
  const indent = Math.min(depth, 5) * 20;
  const isEmpty = root.content === "";
  const isHighlighted = highlighted.has(root.public_id);
  const isReplyTarget = replyingTo === root.public_id;

  return (
    <div style={{ marginLeft: indent }}>
      <div
        className={`rounded border-l-2 bg-panel/40 px-3 py-2 ${
          isReplyTarget ? "border-accent bg-accent/10" : isHighlighted ? "border-accent bg-accent/5" : "border-transparent"
        }`}
      >
        <div className="flex min-w-0 flex-wrap items-baseline gap-2 text-[11px] text-muted [overflow-wrap:anywhere]">
          <span className="font-semibold text-slate-100">{root.peer_name}</span>
          {root.role && <span>{root.role}</span>}
          <span className="font-mono [overflow-wrap:anywhere]">#{root.seq_in_session}</span>
          {orphaned && (
            <span
              className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-amber-300"
              title="The message this replies to is not in this page of results -- shown here as its own thread, from this point down."
            >
              orphan
            </span>
          )}
          <span className="ml-auto">{relativeIsh(root.created_at)}</span>
        </div>
        {isEmpty ? (
          <p className="mt-1 text-xs italic text-muted">(empty content)</p>
        ) : (
          // Same unbroken-path wrap as `MessageRow` (#33 AC2 round 4).
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-100 [overflow-wrap:anywhere]">{root.content}</p>
        )}
        <button
          onClick={() => onReply(root.public_id)}
          className="mt-1 text-[11px] text-accent hover:underline"
        >
          reply
        </button>
      </div>
      {replies.length > 0 && (
        <div className="mt-1 space-y-1">
          {replies.map((r) => (
            <ThreadNode key={r.root.public_id} thread={r} highlighted={highlighted} onReply={onReply} replyingTo={replyingTo} />
          ))}
        </div>
      )}
    </div>
  );
}
