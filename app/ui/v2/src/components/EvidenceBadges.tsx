import type { EvidenceLabel, EvidenceTone } from "../state/evidenceStatus.types";

const TONE_CLASS: Record<EvidenceTone, string> = {
  ok: "border-accent/40 bg-accent/10 text-accent",
  warn: "border-[#f0a35e]/50 bg-[#f0a35e]/10 text-[#f0a35e]",
  bad: "border-rose-400/50 bg-rose-400/10 text-rose-300",
  pending: "border-edge text-muted",
};

/** One evidence row's status labels (#33 AC3). Every label is a visible
 *  badge; a `warn`/`bad` label also prints its `detail` as text under the
 *  badges, because a stale or unavailable citation must be SEEN, not found
 *  only by hovering. `ok`/`pending` details stay in the tooltip. */
export function EvidenceBadges({ labels }: { labels: EvidenceLabel[] }) {
  const problems = labels.filter((l) => l.tone === "warn" || l.tone === "bad");
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1">
        {labels.map((l) => (
          <span key={l.text} title={l.detail} className={`rounded border px-1 py-px text-[10px] ${TONE_CLASS[l.tone]}`}>
            {l.text}
          </span>
        ))}
      </div>
      {problems.map((l) => (
        <p key={l.text} className={`break-words text-[10px] ${l.tone === "bad" ? "text-rose-300/90" : "text-[#f0a35e]/90"}`}>
          {l.text}: {l.detail}
        </p>
      ))}
    </div>
  );
}
