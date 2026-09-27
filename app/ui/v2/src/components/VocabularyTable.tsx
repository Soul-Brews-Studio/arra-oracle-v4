/** One vocabulary's server-side properties, laid out as a definitions table
 *  rather than a badge row -- most of these fields are meaningless without a
 *  sentence of explanation, so every row carries a `title` tooltip rather
 *  than pretending the raw value is self-describing. `term_policy: sealed`
 *  and `cardinality: one` + `required: true` are the two facts that actually
 *  change what a user can do here, so their hints spell out the consequence,
 *  not just the definition. */
export type VocabularyProps = {
  name: string;
  label: string;
  kind: string;
  term_policy: string;
  cardinality: string;
  required: boolean;
  hierarchy: boolean;
};

const FIELD_HINTS: Record<string, string> = {
  name: "The machine-readable key used in term_snapshot_json (e.g. \"type\"). Stable; not shown to end users.",
  label: "The human-readable display name for this vocabulary.",
  kind: "What KIND of vocabulary this is server-side -- controls how terms in it are validated.",
  term_policy:
    "\"sealed\" means the term list is fixed by the server -- a user cannot add, rename, or remove a term. \"open\" would allow new terms.",
  cardinality:
    "\"one\" means a revision may carry at most one term from this vocabulary. \"many\" would allow several at once.",
  required: "If true, a revision cannot be published without at least one term from this vocabulary.",
  hierarchy: "If true, terms in this vocabulary can nest under a parent term. If false, all terms are flat siblings.",
};

export function VocabularyTable({ vocabulary }: { vocabulary: VocabularyProps }) {
  const rows: Array<[string, string]> = [
    ["name", vocabulary.name],
    ["label", vocabulary.label],
    ["kind", vocabulary.kind],
    ["term_policy", vocabulary.term_policy],
    ["cardinality", vocabulary.cardinality],
    ["required", String(vocabulary.required)],
    ["hierarchy", String(vocabulary.hierarchy)],
  ];

  return (
    <table className="w-full text-xs">
      <tbody>
        {rows.map(([field, value]) => (
          <tr key={field} className="border-b border-edge last:border-0">
            <td
              className="cursor-help py-1 pr-3 align-top font-mono text-[11px] text-muted [overflow-wrap:anywhere]"
              title={FIELD_HINTS[field]}
            >
              {field}
            </td>
            <td className="py-1 font-mono text-[11px] text-slate-100 [overflow-wrap:anywhere]">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
