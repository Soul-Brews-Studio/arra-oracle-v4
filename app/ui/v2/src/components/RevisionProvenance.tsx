import type { RevisionRow } from "../api/knowledge";
import { revisionProvenance } from "../state/revisionProvenance";

/** Where the head revision came from (`revisionProvenance`), including the
 *  explicit "no summary" marker. Absent values render muted and italic so an
 *  absence can never be mistaken for a recorded value; ids and the digest are
 *  monospace and wrap anywhere (a 64-hex digest is one unbroken token). */
export function RevisionProvenance({ revision }: { revision: RevisionRow }) {
  return (
    <dl aria-label="provenance" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px] text-muted">
      {revisionProvenance(revision).map((row) => (
        <div key={row.key} className="contents">
          <dt>{row.label}</dt>
          <dd
            data-prov={row.key}
            className={`[overflow-wrap:anywhere] ${row.recorded ? "text-slate-200" : "italic text-muted"} ${
              row.mono ? "font-mono" : ""
            }`}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
