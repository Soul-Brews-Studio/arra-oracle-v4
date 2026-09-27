import type { RevisionRow } from "../api/knowledge";
import { revisionRoles } from "../state/revisionRoles";

/** Author, observer and subject of one revision as three labelled rows
 *  (`revisionRoles`). An absent role renders muted and italic, in its own
 *  row: "no observer recorded" is information, not an empty cell. Peer names
 *  can be 256 bytes with no spaces, hence `anywhere`. */
export function RevisionRoles({ revision }: { revision: RevisionRow }) {
  return (
    <dl aria-label="roles" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px] text-muted">
      {revisionRoles(revision).map((r) => (
        <div key={r.role} className="contents">
          <dt>{r.role}</dt>
          <dd
            data-role={r.role}
            className={`[overflow-wrap:anywhere] ${r.recorded ? "text-slate-200" : "italic text-muted"}`}
          >
            {r.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}
