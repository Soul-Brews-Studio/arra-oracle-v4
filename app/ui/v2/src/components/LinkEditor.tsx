import { LINK_RELATIONS, type LinkRelation } from "../api/knowledge";
import {
  CITE_TARGET_FIELDS,
  CITE_TARGET_KINDS,
  type CiteTarget,
  type CiteTargetKind,
  type LinkDraft,
} from "../state/linkDraft.types";
import { validateLinkDraft } from "../state/validateLinkDraft";

const INPUT =
  "min-w-0 flex-1 rounded border border-edge bg-ink px-2 py-1 font-mono text-[11px] text-slate-100 outline-none focus:border-accent";
// `min-w-0 max-w-full`: the loaded-revision pick lists titles, and a <select>
// is otherwise as wide as its longest option (#33 AC2 round 4).
const SELECT = "min-w-0 max-w-full rounded border border-edge bg-ink px-1.5 py-1 text-[11px] text-slate-100";

/** Evidence links for the revision being written (#33 AC1 "cite").
 *
 * Controlled: the parent owns the rows and turns them into
 * `link_snapshot_json` with `buildLinkSnapshot` on submit. Each row shows
 * its own shape problems inline as you type (a 20-character id, a
 * `javascript:` URL); whether the target EXISTS is still the server's
 * answer, and a refused publish shows its `invalid_reference at
 * /content/link_snapshot_json` verbatim in the view's error note.
 *
 * A `node_revision` target can be picked from revisions this view already
 * loaded (any node you opened this session, plus this node's history), or
 * typed as two ids. */
export function LinkEditor({
  drafts,
  onChange,
  citeTargets,
}: {
  drafts: LinkDraft[];
  onChange: (drafts: LinkDraft[]) => void;
  citeTargets: CiteTarget[];
}) {
  const update = (i: number, patch: Partial<LinkDraft>) =>
    onChange(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const setField = (i: number, field: string, value: string) =>
    update(i, { fields: { ...drafts[i]!.fields, [field]: value } });

  return (
    <div className="flex flex-col gap-1.5 rounded border border-edge p-2">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="uppercase tracking-wide">evidence links</span>
        <button
          type="button"
          onClick={() =>
            onChange([...drafts, { relation: "supports", target_kind: "node_revision", fields: {}, note: "" }])
          }
          className="rounded border border-edge px-1.5 py-0.5 hover:border-accent hover:text-accent"
        >
          + add evidence link
        </button>
      </div>
      {drafts.length === 0 && <p className="text-[11px] text-muted">none — this revision cites nothing</p>}
      {drafts.map((draft, i) => {
        const problems = validateLinkDraft(draft);
        return (
          <div key={i} className="flex flex-col gap-1 rounded border border-edge/60 p-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                aria-label={`link ${i + 1} relation`}
                value={draft.relation}
                onChange={(e) => update(i, { relation: e.target.value as LinkRelation })}
                className={SELECT}
              >
                {LINK_RELATIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <select
                aria-label={`link ${i + 1} target kind`}
                value={draft.target_kind}
                onChange={(e) => update(i, { target_kind: e.target.value as CiteTargetKind })}
                className={SELECT}
              >
                {CITE_TARGET_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => onChange(drafts.filter((_, j) => j !== i))}
                className="ml-auto text-[11px] text-muted hover:text-rose-300"
              >
                remove
              </button>
            </div>
            {draft.target_kind === "node_revision" && citeTargets.length > 0 && (
              <select
                aria-label={`link ${i + 1} pick a loaded revision`}
                value={`${draft.fields.node_id ?? ""}/${draft.fields.revision_id ?? ""}`}
                onChange={(e) => {
                  const [node_id = "", revision_id = ""] = e.target.value.split("/");
                  update(i, { fields: { ...draft.fields, node_id, revision_id } });
                }}
                className={SELECT}
              >
                <option value="/">pick a revision you have loaded…</option>
                {citeTargets.map((t) => (
                  <option key={t.revision_id} value={`${t.node_id}/${t.revision_id}`}>
                    #{t.revision_no} — {t.title} ({t.node_id.slice(0, 8)}…)
                  </option>
                ))}
              </select>
            )}
            <div className="flex flex-wrap gap-1.5">
              {CITE_TARGET_FIELDS[draft.target_kind].map((field) => (
                <input
                  key={field}
                  aria-label={`link ${i + 1} ${field}`}
                  value={draft.fields[field] ?? ""}
                  onChange={(e) => setField(i, field, e.target.value)}
                  placeholder={field}
                  className={INPUT}
                />
              ))}
            </div>
            <input
              aria-label={`link ${i + 1} note`}
              value={draft.note}
              onChange={(e) => update(i, { note: e.target.value })}
              placeholder="note (optional)…"
              className={INPUT}
            />
            {problems.map((p) => (
              <p key={p} className="text-[11px] text-rose-300">
                {p}
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}
