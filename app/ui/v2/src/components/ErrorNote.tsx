import type { ErrorEnvelope } from "../api/memory";
import { authErrorHint } from "../state/authErrorHint";
import { authErrorHintFromText } from "../state/authErrorHintFromText";

/** Renders `asError()`'s output verbatim -- the same "don't flatten to a
 *  string" stance ResponsePanel takes with a full ApiResult, scoped down to
 *  just the error envelope. `code` is what tells you what happened;
 *  `pointer` says which field caused it, so it sits beside code in mono.
 *  #33 AC2/R12 (a11y slice): a bare `unauthenticated`/`forbidden` code is
 *  correct but not honest enough on its own -- `authErrorHint` adds the one
 *  sentence that says WHAT to do about a 401 or a 403, without inventing
 *  anything for a code that has no specific hint. */
export function ErrorNote({ error }: { error: ErrorEnvelope }) {
  // Several call sites (`KnowledgeView`'s `k.error`, `App.tsx`'s
  // `m.messageError`) wrap `describe()`'s bare governed code as
  // `{code:"refused"|"request failed", message: theActualCode}` rather than
  // passing a real `ErrorEnvelope` through -- so the 401/403 code this hint
  // keys off can be sitting in `message`, verbatim, not `code`. Checking both
  // is safe: `describe()` never appends anything to a bare code with no
  // pointer, so `message` is either exactly `"unauthenticated"`/`"forbidden"`
  // or something authErrorHint doesn't recognise anyway -- except that an
  // envelope WITH a pointer arrives as `forbidden at /peer_name`, hence the
  // first-word match (the same one `Transcript` makes).
  const hint = authErrorHint(error.code) ?? authErrorHintFromText(error.message);
  return (
    <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-rose-300">{error.code ?? "error"}</span>
        {error.pointer && <span className="font-mono text-rose-200/80">{error.pointer}</span>}
      </div>
      {error.message && <p className="mt-1 text-muted">{error.message}</p>}
      {hint !== null && <p className="mt-1 text-muted">{hint}</p>}
    </div>
  );
}
