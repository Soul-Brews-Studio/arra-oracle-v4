import { chatError } from "../state/chatError";

/** Renders `useMemory`'s `askError` through the pure `chatError` mapping --
 *  `model_unavailable` (#32 / R9) gets its own amber note distinct from any
 *  other failure, matching `ModelNote`'s tone below it, rather than the
 *  generic rose error text every other panel in this app uses for "the
 *  server refused this". */
export function ChatError({ code }: { code: string | null }) {
  const view = chatError(code);
  if (view === null) return null;

  if (view.kind === "model_unavailable") {
    return (
      <div className="rounded border border-[#f0a35e]/40 bg-[#f0a35e]/10 px-3 py-2 text-xs">
        <p className="font-semibold text-[#f0a35e]">{view.title}</p>
        <p className="mt-1 text-muted">{view.detail}</p>
      </div>
    );
  }
  return (
    <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs">
      <p className="font-semibold text-rose-300">{view.title}</p>
      <p className="mt-1 text-muted">{view.detail}</p>
    </div>
  );
}
