import { useState } from "react";
import type { MessageRow } from "../api/memory";

/** Composes a reply to ONE specific message. `replyingTo` is shown, not just
 *  held: a reply box that doesn't display its target is how you end up
 *  replying to the wrong thing, so the quoted excerpt stays on screen for
 *  the whole time you're typing. `onCancel` clears the target without
 *  losing the composer -- a plain message (no `in_reply_to`) is still a
 *  valid thing to send from here. */
export function ReplyComposer({
  replyingTo,
  peerName,
  onSend,
  sending,
  onCancel,
}: {
  replyingTo: MessageRow | null;
  peerName: string;
  onSend: (peerName: string, role: string | null, content: string, inReplyTo: string | null) => void;
  sending: boolean;
  onCancel: () => void;
}) {
  const [peer, setPeer] = useState(peerName);
  const [role, setRole] = useState("");
  const [content, setContent] = useState("");

  const canSend = !sending && peer.trim() !== "" && content !== "";

  const send = () => {
    if (!canSend) return;
    onSend(peer.trim(), role.trim() === "" ? null : role.trim(), content, replyingTo?.public_id ?? null);
    setContent("");
  };

  return (
    <div className="border-t border-edge bg-panel/60 p-3">
      {replyingTo && (
        <div className="mb-2 flex items-start gap-2 rounded border border-accent/30 bg-accent/5 px-2 py-1.5 text-xs">
          <div className="min-w-0 flex-1">
            <span className="font-semibold text-accent">replying to {replyingTo.peer_name}</span>
            <p className="mt-0.5 truncate text-muted">{replyingTo.content || "(empty content)"}</p>
          </div>
          <button onClick={onCancel} className="shrink-0 text-muted hover:text-slate-100">
            cancel
          </button>
        </div>
      )}
      <div className="mb-2 flex gap-2">
        <input
          value={peer}
          onChange={(e) => setPeer(e.target.value)}
          placeholder="peer name"
          className="w-32 rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
        />
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="role (optional)"
          className="w-32 rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
        />
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
        }}
        rows={3}
        placeholder={replyingTo ? "reply content (Ctrl/Cmd+Enter to send)" : "message content (Ctrl/Cmd+Enter to send)"}
        className="w-full resize-none rounded border border-edge bg-ink px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-accent"
      />
      <div className="mt-2 flex justify-end">
        <button
          onClick={send}
          disabled={!canSend}
          className="rounded border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-40"
        >
          {sending ? "sending…" : replyingTo ? "send reply" : "send"}
        </button>
      </div>
    </div>
  );
}
