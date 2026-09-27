/**
 * `answerChat` calls the chat model the SERVER was configured with (#32,
 * overnight ruling R9): local Ollama, `ARRA_CHAT_PROVIDER=ollama`, model
 * `ARRA_CHAT_MODEL` (default gemma3:4b). The local dev stack turns it on by
 * default. With no model configured -- or with one that is stopped, slow or
 * failing -- the server answers its own closed code, `model_unavailable`
 * (503). It used to answer `writer_unavailable`, which could not be told
 * apart from a genuinely busy dataset writer. `getContext` never calls a
 * model, so it still answers either way: that is the quickest way to tell
 * "no model" from "server broken". `getChatSettings` says which model, or
 * `{model: null}`.
 */
export function ModelNote() {
  return (
    <div className="rounded border border-edge bg-panel px-3 py-2 text-[11px] leading-relaxed text-muted">
      <p>
        <span className="text-accent">Answers come from a local model.</span> The server answers with the
        chat model it was started with (<code className="text-slate-300 [overflow-wrap:anywhere]">ARRA_CHAT_PROVIDER=ollama</code>,
        default <code className="text-slate-300 [overflow-wrap:anywhere]">gemma3:4b</code>), using only the evidence this peer may
        read. It is recorded understanding, not a live agent: nobody is contacted. If no model is configured
        or it is not running, Ask returns <code className="text-slate-300 [overflow-wrap:anywhere]">model_unavailable</code> --
        `getContext` below has no model dependency and should still answer normally.
      </p>
    </div>
  );
}
