/**
 * `answerChat` (service.ts) calls an injected `ChatModelFn` -- "a real
 * caller supplies a real model, a test supplies a stub" (chat.ts). A default
 * local server wires neither, so the call throws and `mapModelFailure()`
 * (chat.ts) maps it to a refusal:
 *
 *   return failPublication("writer_unavailable", "");
 *
 * That comment in chat.ts is explicit that this is a REUSE of an existing
 * code, not a new one, chosen because "the thing this call depends on to do
 * its job is not available right now" already fits a missing model exactly
 * as well as a timeout or rate limit. So on a stock local server, seeing
 * `writer_unavailable` from the dialectic panel is the EXPECTED result, not
 * a bug -- `getContext` (read-only, no model) still works fine, which is
 * the fastest way to tell "no model configured" apart from "server is
 * actually broken".
 */
export function ModelNote() {
  return (
    <div className="rounded border border-edge bg-panel px-3 py-2 text-[11px] leading-relaxed text-muted">
      <p>
        <span className="text-accent">No chat model wired?</span> That's expected on a default local
        server. `answerChat` needs an injected model function; without one it throws and{" "}
        <code className="text-slate-300">mapModelFailure()</code> returns{" "}
        <code className="text-slate-300">writer_unavailable</code> on purpose -- reused deliberately,
        not a new error code. A refusal envelope here means the server is working correctly with no
        model configured, not that something broke. `getContext` below has no model dependency and
        should still answer normally.
      </p>
    </div>
  );
}
