import type { RevisionRow } from "../api/knowledge";

/** One provenance line. `recorded: false` marks an absence the view must show
 *  as an absence (muted), not as a value. */
export type ProvenanceRow = { key: string; label: string; value: string; recorded: boolean; mono: boolean };

function validity(from: string | null, to: string | null): string {
  if (from === null && to === null) return "no validity window recorded";
  if (to === null) return `from ${from}, open-ended`;
  if (from === null) return `until ${to}`;
  return `from ${from} to ${to}`;
}

/** #33 design revision 2 "render provenance": where the head revision came
 *  from, read only off the columns the 26-field row carries -- the session it
 *  was published in, the caller-minted operation, the base it edited, when it
 *  landed, why, the window it claims, and the digest of its canonical
 *  envelope (shown in full: a truncated digest cannot be compared).
 *
 *  `summary` is always the absent marker. The revision contract has no
 *  summary column, and DESIGN keeps a saved summary as its own revisionable
 *  node, so there is nothing on this row to show -- and a line lifted from the
 *  body would be a fabricated summary, which revision 2 forbids. */
export function revisionProvenance(r: RevisionRow): ProvenanceRow[] {
  const row = (key: string, label: string, value: string | null, absent: string, mono = false): ProvenanceRow => ({
    key,
    label,
    value: value ?? absent,
    recorded: value !== null,
    mono: mono && value !== null,
  });
  return [
    row("summary", "summary", null, "no summary"),
    row("revision", "revision", `#${r.revision_no} · ${r.id}`, "", true),
    row("base", "base revision", r.base_revision_id, "none — first revision of this node", true),
    row("session", "session", r.session_name, "no session recorded"),
    row("operation", "operation", r.operation_id, "", true),
    row("created", "created", r.created_at, ""),
    row("reason", "change reason", r.change_reason, "no change reason recorded"),
    {
      key: "validity",
      label: "valid",
      value: validity(r.valid_from, r.valid_to),
      recorded: r.valid_from !== null || r.valid_to !== null,
      mono: false,
    },
    row("digest", "content digest", r.content_digest, "", true),
    row("envelope", "envelope", `${r.canonical_version} · schema ${r.schema_version}`, ""),
  ];
}
