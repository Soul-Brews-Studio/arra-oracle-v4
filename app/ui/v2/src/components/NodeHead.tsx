import { type RevisionRow, parseTerms, typeOf, horizonOf } from "../api/knowledge";
import type { ErrorEnvelope } from "../api/memory";
import { TypeBadge } from "./TypeBadge";
import { HorizonBadge } from "./HorizonBadge";
import { ErrorNote } from "./ErrorNote";
import { EmptyState } from "./EmptyState";

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
        <p className="font-mono text-xs text-muted">{node.node_id}</p>
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
  // The row DOES carry content_digest -- sha256 over the canonical envelope.
  // It is the thing that makes "same content" decidable without diffing two
  // bodies, so it is worth the line even truncated.
  const digest = `${revision.content_digest.slice(0, 12)}…`;

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
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

      {revision.body_format === "text" ? (
        <pre className="whitespace-pre-wrap rounded border border-edge bg-panel p-3 text-xs text-slate-200">
          {revision.body}
        </pre>
      ) : (
        // No markdown renderer wired in -- POC scope. Shown as plain text
        // rather than silently dropped so the body is still legible.
        <p className="whitespace-pre-wrap text-xs text-slate-200">{revision.body}</p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-edge pt-2 text-[11px] text-muted">
        <dt>revision</dt>
        <dd className="text-slate-200">{revision.revision_no}</dd>
        <dt>created</dt>
        <dd className="text-slate-200">{revision.created_at}</dd>
        <dt>active</dt>
        <dd className="text-slate-200">{revision.is_active ? "yes" : "no"}</dd>
        <dt>digest</dt>
        <dd className="font-mono text-slate-200">{digest}</dd>
      </dl>
    </div>
  );
}
