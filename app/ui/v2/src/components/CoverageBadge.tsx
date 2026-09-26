import type { ContextResult } from "../api/memory";

/**
 * `coverage` answers "is this everything?" (#85, overnight ruling R4):
 * `"full"` only when nothing was excluded for any reason. An unauthorized
 * omission counts, because the caller did not get the whole picture even if
 * access control was right to withhold it. The server derives this; the
 * badge only has to say what it means and point at the excluded list for
 * the why.
 */
export function CoverageBadge({ coverage }: { coverage: ContextResult["coverage"] }) {
  const full = coverage === "full";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        full ? "border-accent/40 text-accent" : "border-[#f0a35e]/40 text-[#f0a35e]"
      }`}
      title={
        full
          ? "Nothing was excluded: every candidate was authorized and fit inside max_items, the wire budget and the linked-session bound."
          : "Something was left out: unauthorized evidence, a max_items or wire-budget stop, or linked sessions past the bound. The excluded list says which."
      }
    >
      <span className={`h-1.5 w-1.5 rounded-full ${full ? "bg-accent" : "bg-[#f0a35e]"}`} />
      {full ? "full coverage" : "partial coverage"}
    </span>
  );
}
