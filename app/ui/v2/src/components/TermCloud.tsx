import type { TermSnapshot } from "../api/knowledge";
import { TermCloudEmpty } from "./TermCloudEmpty";

/** Four discrete size steps, not a continuous scale keyed to raw frequency --
 *  a smooth gradient over what is usually a sample of a handful of revisions
 *  would imply a precision about relative popularity that a sample this small
 *  cannot support. Step index 1..4, biggest last. */
const SIZE_CLASSES = ["text-[11px]", "text-xs", "text-sm", "text-base"];

type Counted = { name: string; count: number };

function countTerms(terms: TermSnapshot[]): Map<string, Counted[]> {
  const byVocab = new Map<string, Map<string, number>>();
  for (const t of terms) {
    const vocab = t.vocabulary_name_snapshot;
    const counts = byVocab.get(vocab) ?? new Map<string, number>();
    counts.set(t.term_name_snapshot, (counts.get(t.term_name_snapshot) ?? 0) + 1);
    byVocab.set(vocab, counts);
  }
  const out = new Map<string, Counted[]>();
  for (const [vocab, counts] of byVocab) {
    out.set(
      vocab,
      [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    );
  }
  return out;
}

/** Maps a count to one of 4 size steps, scaled against this GROUP's own max
 *  -- so "type" and "memory_horizon" each get their own sense of "big" rather
 *  than one vocabulary drowning the other's scale. */
function sizeStep(count: number, maxInGroup: number): number {
  if (maxInGroup <= 1) return 0;
  const ratio = count / maxInGroup;
  return Math.min(3, Math.floor(ratio * 4));
}

export function TermCloud({
  terms,
  onSelect,
  selected,
}: {
  terms: TermSnapshot[];
  onSelect: (termName: string) => void;
  selected: string | null;
}) {
  if (terms.length === 0) return <TermCloudEmpty />;

  const byVocab = countTerms(terms);

  return (
    <div className="flex flex-col gap-4">
      {[...byVocab.entries()].map(([vocab, counted]) => {
        const maxInGroup = counted[0]?.count ?? 1;
        return (
          <div key={vocab}>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{vocab}</p>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {counted.map(({ name, count }) => {
                const step = sizeStep(count, maxInGroup);
                const isSelected = selected === name;
                return (
                  <button
                    key={name}
                    onClick={() => onSelect(name)}
                    title={`${name} -- ${count} revision${count === 1 ? "" : "s"} in this sample`}
                    className={`${SIZE_CLASSES[step]} rounded px-1.5 py-0.5 font-medium hover:bg-accent/10 ${
                      isSelected ? "bg-accent/15 text-accent" : "text-slate-100"
                    }`}
                  >
                    {name}
                    <span className="ml-1 text-muted">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
