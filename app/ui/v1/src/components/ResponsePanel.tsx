import type { ApiResult } from "../api/client";
import { StatusBadge } from "./StatusBadge";

export function ResponsePanel({ result }: { result: ApiResult | null }) {
  if (!result) {
    return (
      <section className="flex w-1/2 shrink-0 items-center justify-center border-l border-edge text-sm text-muted">
        No response yet.
      </section>
    );
  }

  return (
    <section className="flex w-1/2 shrink-0 flex-col border-l border-edge">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
        <StatusBadge status={result.status} />
        <span className="text-[11px] text-muted">{result.durationMs}ms</span>
        {result.error && <span className="text-[11px] text-rose-300">{result.error}</span>}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto bg-ink p-4 font-mono text-xs leading-relaxed text-slate-100">
        {JSON.stringify(result.body, null, 2)}
      </pre>
    </section>
  );
}
