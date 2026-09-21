import type { Action } from "../api/methods";

/** write is visually louder than read on purpose: it is the one that mutates. */
export function ActionBadge({ action }: { action: Action }) {
  const write = action === "content:write";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${
        write
          ? "bg-rose-500/15 text-rose-300 ring-rose-500/30"
          : "bg-slate-500/15 text-slate-300 ring-slate-500/30"
      }`}
    >
      {write ? "write" : "read"}
    </span>
  );
}
