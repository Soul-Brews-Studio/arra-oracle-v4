import { type RevisionRow, parseTerms, typeOf, horizonOf } from "../api/knowledge";
import type { ErrorEnvelope } from "../api/memory";
import { TypeBadge } from "./TypeBadge";
import { HorizonBadge } from "./HorizonBadge";
import { ErrorNote } from "./ErrorNote";
import { EmptyState } from "./EmptyState";
import { RevisionProvenance } from "./RevisionProvenance";
import { RevisionRoles } from "./RevisionRoles";

/** The accepted head of the selected node -- `getAcceptedHead`'s row,
 *  rendered. `node` only needs the id: this tier has no separate "node"
 *  object, the head revision IS the node's current state. */
export function NodeHead({
  node,
  revision,
  loading,
  error,
}: {
  node: { node_id: string };
  revision: RevisionRow | null;
  loading: boolean;
  error: ErrorEnvelope | null;
}) {
  if (loading) {
    return <EmptyState title="loading…" detail={node.node_id} />;
  }
  if (error) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <p className="font-mono text-xs text-muted [overflow-wrap:anywhere]">{node.node_id}</p>
        <ErrorNote error={error} />
      </div>
    );
  }
  if (revision === null) {
    return <EmptyState title="no accepted revision" detail={`${node.node_id} has not published yet`} />;
  }

  const terms = parseTerms(revision);
  const type = typeOf(terms);
  const horizon = horizonOf(terms);

  // #33 AC2 round 3: `flex-none`, not its own scroller. As a nested
  // `flex-1 overflow-y-auto` inside KnowledgeView's scrolling `<main>` it
  // measured 32px tall at 1440x900 (a scroll container's automatic
  // min-height is 0); the column around it does the scrolling instead.
  return (
    <div className="flex flex-none flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        {/* min-w-0 + break-words: an unbroken title (no spaces) is a flex
            item here, and a flex item's default min-width is its content
            width -- without both, a long enough title pushes this row (and
            the page) wider than the viewport instead of wrapping. */}
        <h2 className="min-w-0 break-words text-sm font-semibold text-slate-100">{revision.title}</h2>
        <div className="flex shrink-0 gap-1.5">
          {type && <TypeBadge type={type} />}
          {horizon && <HorizonBadge horizon={horizon} />}
        </div>
      </div>

      {/* #33 AC2 round 5: `anywhere`, so a repo path or an absolute path in
          the body breaks mid-token instead of running past a 320px column. */}
      {revision.body_format === "text" ? (
        <pre className="whitespace-pre-wrap rounded border border-edge bg-panel p-3 text-xs text-slate-200 [overflow-wrap:anywhere]">
          {revision.body}
        </pre>
      ) : (
        // No markdown renderer wired in -- POC scope. Shown as plain text
        // rather than silently dropped so the body is still legible.
        <p className="whitespace-pre-wrap text-xs text-slate-200 [overflow-wrap:anywhere]">{revision.body}</p>
      )}

      {/* #33 design revision 2: roles and provenance for the head itself,
          not only inside a diff -- a lone head has no other place to say who
          wrote it, whose view it is, who it is about, or where it came from. */}
      <section aria-label="roles and provenance" className="flex flex-col gap-2 border-t border-edge pt-2">
        <RevisionRoles revision={revision} />
        <RevisionProvenance revision={revision} />
        <p className="text-[11px] text-muted">
          active: <span className="text-slate-200">{revision.is_active ? "yes" : "no"}</span>
        </p>
      </section>
    </div>
  );
}
