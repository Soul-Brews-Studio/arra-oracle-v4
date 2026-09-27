import { useEffect, useRef } from "react";
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
  // #33 AC2 (ui-keys): opening a node moves focus to its title, once per
  // node, so a keyboard user lands on what they opened instead of on <body>
  // (the NodeRail entry, search hit or correction form that had focus is
  // often gone by then). Only when focus is OUTSIDE <main> or lost: a user
  // already working in this node's forms is never pulled away. A new head
  // revision of the SAME node also takes focus, but only if it was lost --
  // measured by the keyboard e2e: the publish form clears on submit, its
  // button turns disabled under the focus, and focus fell to <body>.
  const h2Ref = useRef<HTMLHeadingElement>(null);
  const focusedFor = useRef<string | null>(null);
  const ready = !loading && error === null && revision !== null;
  const revisionId = revision?.id ?? null;
  useEffect(() => {
    if (!ready || h2Ref.current === null) return;
    const newNode = focusedFor.current !== node.node_id;
    focusedFor.current = node.node_id;
    const at = document.activeElement;
    const lost = at === null || at === document.body;
    if (lost || (newNode && at.closest("main") === null)) h2Ref.current.focus();
  }, [ready, node.node_id, revisionId]);

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
  // The row DOES carry content_digest -- sha256 over the canonical envelope.
  // It is the thing that makes "same content" decidable without diffing two
  // bodies, so it is worth the line even truncated.
  const digest = `${revision.content_digest.slice(0, 12)}…`;

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
        <h2 ref={h2Ref} tabIndex={-1} className="min-w-0 break-words text-sm font-semibold text-slate-100">{revision.title}</h2>
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

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-edge pt-2 text-[11px] text-muted">
        <dt>revision</dt>
        <dd className="text-slate-200">{revision.revision_no}</dd>
        <dt>created</dt>
        <dd className="text-slate-200">{revision.created_at}</dd>
        <dt>active</dt>
        <dd className="text-slate-200">{revision.is_active ? "yes" : "no"}</dd>
        <dt>digest</dt>
        <dd className="font-mono text-slate-200 [overflow-wrap:anywhere]">{digest}</dd>
      </dl>
    </div>
  );
}
