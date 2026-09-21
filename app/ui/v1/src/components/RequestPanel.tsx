import type { Method } from "../api/methods";
import { ActionBadge } from "./ActionBadge";

export function RequestPanel({
  method,
  body,
  onBody,
  onSend,
  busy,
}: {
  method: Method | null;
  body: string;
  onBody: (v: string) => void;
  onSend: () => void;
  busy: boolean;
}) {
  if (!method) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">
        Pick a method to start.
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
        <code className="text-xs text-accent">POST</code>
        <code className="text-xs text-slate-300">/api/knowledge/:bank/{method.name}</code>
        <ActionBadge action={method.action} />
        {method.action === "content:write" && (
          <span className="ml-auto text-[11px] text-amber-300/80">mutates state</span>
        )}
      </div>
      <textarea
        value={body}
        onChange={(e) => onBody(e.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-ink p-4 font-mono text-xs leading-relaxed text-slate-100 outline-none"
      />
      <div className="flex items-center gap-3 border-t border-edge px-4 py-2.5">
        <button
          onClick={onSend}
          disabled={busy}
          className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40"
        >
          {busy ? "sending…" : "send"}
        </button>
        <span className="text-[11px] text-muted">
          every body needs <code className="text-slate-300">workspace_name</code>, and it must match the bank
        </span>
      </div>
    </section>
  );
}
