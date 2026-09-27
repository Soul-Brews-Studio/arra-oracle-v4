import { useState } from "react";

/** Appends one message. `disabledReason` is shown rather than just graying
 *  the button out -- "why can't I type" is the first question a disabled
 *  composer raises, so the answer sits right next to it. */
export function Composer({
  peerName,
  onSend,
  sending,
  disabled,
  disabledReason,
}: {
  peerName: string;
  onSend: (peerName: string, role: string | null, content: string) => void;
  sending: boolean;
  disabled: boolean;
  disabledReason: string | null;
}) {
  const [peer, setPeer] = useState(peerName);
  const [role, setRole] = useState("");
  const [content, setContent] = useState("");

  const canSend = !disabled && !sending && peer.trim() !== "" && content !== "";

  const send = () => {
    if (!canSend) return;
    onSend(peer.trim(), role.trim() === "" ? null : role.trim(), content);
    setContent("");
  };

  return (
    <div className="border-t border-edge bg-panel/60 p-3">
      {disabled && disabledReason && <p className="mb-2 text-xs text-muted">{disabledReason}</p>}
      <div className="mb-2 flex gap-2">
        <input
          value={peer}
          onChange={(e) => setPeer(e.target.value)}
          disabled={disabled}
          placeholder="peer name"
          aria-label="Peer name"
          className="w-32 rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        />
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={disabled}
          placeholder="role (optional)"
          aria-label="Role (optional)"
          className="w-32 rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        />
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
        }}
        disabled={disabled}
        rows={3}
        placeholder="message content (Ctrl/Cmd+Enter to send)"
        aria-label="Message content"
        className="w-full resize-none rounded border border-edge bg-ink px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      />
      <div className="mt-2 flex justify-end">
        <button
          onClick={send}
          disabled={!canSend}
          className="rounded border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
        >
          {sending ? "sending…" : "send"}
        </button>
      </div>
    </div>
  );
}
