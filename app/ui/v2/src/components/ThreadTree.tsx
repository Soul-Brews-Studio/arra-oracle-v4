import type { Thread } from "../forum/threads";
import { ThreadNode } from "./ThreadNode";

/** Renders a forest of root threads. Just a map over `ThreadNode` -- the
 *  recursion that turns one root into a subtree lives there, this only
 *  handles the top-level list and the "nothing to show" case. */
export function ThreadTree({
  threads,
  highlighted,
  onReply,
  replyingTo,
}: {
  threads: Thread[];
  highlighted: Set<string>;
  onReply: (publicId: string) => void;
  replyingTo: string | null;
}) {
  if (threads.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-muted">no messages in this thread view</p>;
  }
  return (
    <div className="space-y-2">
      {threads.map((t) => (
        <ThreadNode key={t.root.public_id} thread={t} highlighted={highlighted} onReply={onReply} replyingTo={replyingTo} />
      ))}
    </div>
  );
}
