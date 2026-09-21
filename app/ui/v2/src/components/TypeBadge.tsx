/** The `type` term, badged. `type` is `required: true, cardinality: one,
 *  term_policy: sealed` (knowledge.ts trap 3) -- a revision cannot exist
 *  without exactly one of these five values, which is why every value gets
 *  its own colour rather than a shared neutral chip. */
const CLASS: Record<string, string> = {
  note: "border-muted/40 bg-muted/10 text-muted",
  conclusion: "border-accent/40 bg-accent/10 text-accent",
  learning: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  discussion: "border-violet-400/40 bg-violet-400/10 text-violet-300",
  correction: "border-[#f0a35e]/40 bg-[#f0a35e]/10 text-[#f0a35e]",
};

export function TypeBadge({ type }: { type: string }) {
  const cls = CLASS[type] ?? CLASS.note;
  return (
    <span
      title="type: a REQUIRED, exactly-one, sealed vocabulary term -- a revision cannot exist without exactly one"
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
    >
      {type}
    </span>
  );
}
