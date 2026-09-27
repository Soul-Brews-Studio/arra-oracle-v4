import type { LifecycleGate } from "../state/lifecycleGate";

/** The Knowledge view's lifecycle label (#33): a superseded, retired or
 *  unreadable-lifecycle node says so right under its head, with a link to
 *  the successor when the supersede event names one. Nothing for an active
 *  node -- the absence of a label is the "active" state. */
export function LifecycleBanner({ gate }: { gate: LifecycleGate }) {
  if (gate.label === null) return null;
  const terminal = gate.state === "superseded" || gate.state === "retired";
  return (
    <div role="status" className="flex flex-col gap-1 border-b border-edge px-4 py-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            terminal ? "border-rose-400/40 bg-rose-400/10 text-rose-300" : "border-[#f0a35e]/40 text-[#f0a35e]"
          }`}
        >
          {gate.label}
        </span>
        {gate.successor !== null && (
          <a
            href={`#/knowledge?node=${encodeURIComponent(gate.successor.node_id)}`}
            className="text-accent underline underline-offset-2"
          >
            open successor: {gate.successor.title ?? gate.successor.node_id}
          </a>
        )}
      </div>
      <p className="text-muted">{gate.explanation}</p>
    </div>
  );
}
