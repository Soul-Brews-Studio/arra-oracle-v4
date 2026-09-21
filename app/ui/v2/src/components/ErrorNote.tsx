import type { ErrorEnvelope } from "../api/memory";

/** Renders `asError()`'s output verbatim -- the same "don't flatten to a
 *  string" stance ResponsePanel takes with a full ApiResult, scoped down to
 *  just the error envelope. `code` is what tells you what happened;
 *  `pointer` says which field caused it, so it sits beside code in mono. */
export function ErrorNote({ error }: { error: ErrorEnvelope }) {
  return (
    <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-rose-300">{error.code ?? "error"}</span>
        {error.pointer && <span className="font-mono text-rose-200/80">{error.pointer}</span>}
      </div>
      {error.message && <p className="mt-1 text-muted">{error.message}</p>}
    </div>
  );
}
