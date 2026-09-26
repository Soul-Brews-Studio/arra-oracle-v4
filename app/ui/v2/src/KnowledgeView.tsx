import { useEffect, useMemo, useState } from "react";
import { type Bank, newPublicId } from "./api/memory";
import { horizonOf, parseTerms, type RevisionRow, typeOf } from "./api/knowledge";
import { EmptyState } from "./components/EmptyState";
import { ErrorNote } from "./components/ErrorNote";
import { HorizonBadge } from "./components/HorizonBadge";
import { NodeHead } from "./components/NodeHead";
import { NodeRail } from "./components/NodeRail";
import { PublishForm } from "./components/PublishForm";
import { RevisionDiff } from "./components/RevisionDiff";
import { RevisionHistory } from "./components/RevisionHistory";
import { TaxonomySetup } from "./components/TaxonomySetup";
import { TermCloud } from "./components/TermCloud";
import { TermCloudEmpty } from "./components/TermCloudEmpty";
import { TypeBadge } from "./components/TypeBadge";
import { compareRevisionNo } from "./state/compareRevisionNo";
import { useKnowledge } from "./state/useKnowledge";

/** The knowledge half: nodes, immutable revisions, type and tags.
 *
 * Laid out to match what the data is, the same way the messaging view is:
 *
 *   rail    -- WHICH node (bookmarks, because nothing enumerates)
 *   centre  -- the accepted HEAD, and the revision chain behind it
 *   right   -- the taxonomy that types it, and the tags actually in use
 *
 * A draft node id is minted up front rather than on submit, so the id you
 * publish under is the one already on screen. Publishing is the only way a
 * node becomes real, and `publishRevision` is the only write here.
 */
export function KnowledgeView({
  bank,
  nodeId,
  onSelectNode,
}: {
  bank: Bank;
  nodeId: string | null;
  onSelectNode: (id: string | null) => void;
}) {
  const k = useKnowledge(bank);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [termFilter, setTermFilter] = useState<string | null>(null);

  const terms = useMemo(() => parseTerms(k.head?.revision ?? null), [k.head]);

  // #33 revision diff: newest first, the order a "pick two to compare" list
  // wants -- `k.history` itself stays in whatever order the server sent (see
  // `RevisionHistory`'s own comment), this sort is local to the picker.
  const sortedHistory = useMemo(
    () => [...k.history].sort((a, b) => compareRevisionNo(a.revision_no, b.revision_no)),
    [k.history],
  );
  const [diffFromId, setDiffFromId] = useState<string | null>(null);
  const [diffToId, setDiffToId] = useState<string | null>(null);
  useEffect(() => {
    const stillValid = (id: string | null) => id !== null && sortedHistory.some((r) => r.id === id);
    if (sortedHistory.length === 0) {
      setDiffFromId(null);
      setDiffToId(null);
      return;
    }
    // Default to the two newest -- the edit most likely worth reviewing --
    // falling back to comparing the only revision against itself when there
    // is just one, which the render below shows as "pick two different
    // revisions" rather than a diff.
    if (!stillValid(diffToId)) setDiffToId(sortedHistory[0]!.id);
    if (!stillValid(diffFromId)) setDiffFromId((sortedHistory[1] ?? sortedHistory[0])!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedHistory]);
  const diffFrom: RevisionRow | null = sortedHistory.find((r) => r.id === diffFromId) ?? null;
  const diffTo: RevisionRow | null = sortedHistory.find((r) => r.id === diffToId) ?? null;

  // The URL owns the selection here too, so a `#/knowledge?node=…` link opens
  // that node directly and Back leaves it the way clicking got you there.
  useEffect(() => {
    if (nodeId !== k.selected) k.setSelected(nodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);
  const target = k.selected ?? draftId;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r border-edge p-3">
        <NodeRail
          entries={k.nodes}
          selected={k.selected}
          onSelect={(id) => {
            setDraftId(null);
            onSelectNode(id);
          }}
          onAdd={k.actions.addNode}
          onRemove={k.actions.removeNode}
          onNew={() => {
            onSelectNode(null);
            setDraftId(newPublicId());
          }}
          busy={k.busy}
          titles={k.titles}
        />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {target === null ? (
          <EmptyState
            title="No node selected"
            detail="Pick a bookmarked node, or start a new one. Node ids are minted here — the server does not allocate them, and nothing lists nodes you did not create."
          />
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
              <span className="font-mono text-[11px] text-muted" title={target}>
                {target.slice(0, 10)}…
              </span>
              {terms.length > 0 && <TypeBadge type={typeOf(terms) ?? "note"} />}
              <HorizonBadge horizon={horizonOf(terms)} />
              {draftId !== null && (
                <span className="ml-auto text-[11px] text-[#f0a35e]">
                  draft — not published yet
                </span>
              )}
            </div>
            <NodeHead
              // The server's node row keys its id as `id`; this component
              // only needs the identifier for display, and `target` is
              // already the authoritative one (a draft has no server row).
              node={{ node_id: target }}
              revision={k.head?.revision ?? null}
              loading={k.loading}
              error={null}
            />
            <RevisionHistory
              // Newest first, matching this component's own documented
              // contract ("`revisions` is NOT re-sorted here -- the caller
              // decides order"). Fix-round finding: this used to pass
              // `k.history` straight through, which is whatever order the
              // server sent (oldest first) -- the opposite of what the
              // component's own comment promised.
              revisions={sortedHistory}
              headRevisionId={k.snapshotHead ?? k.head?.revision?.id ?? null}
              loading={k.loading}
              error={null}
              onSelect={(id) => {
                // POC: history is a record to read, not a checkout --
                // selecting a past revision does not restore it, supersede is
                // a new revision, never a rewind. What selecting DOES do is
                // pick it as the base ("from") side of the diff below, so
                // clicking any past entry immediately shows "that revision
                // vs whatever `to` is" (head, by default).
                setDiffFromId(id);
              }}
            />
            {sortedHistory.length >= 2 && (
              <div className="flex flex-col gap-2 border-t border-edge p-3">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                  <span className="uppercase tracking-wide">diff</span>
                  <select
                    value={diffFromId ?? ""}
                    onChange={(e) => setDiffFromId(e.target.value)}
                    className="rounded border border-edge bg-ink px-2 py-1 text-slate-100 outline-none focus:border-accent"
                  >
                    {sortedHistory.map((r) => (
                      <option key={r.id} value={r.id}>
                        #{r.revision_no} — {r.title}
                      </option>
                    ))}
                  </select>
                  <span>vs</span>
                  <select
                    value={diffToId ?? ""}
                    onChange={(e) => setDiffToId(e.target.value)}
                    className="rounded border border-edge bg-ink px-2 py-1 text-slate-100 outline-none focus:border-accent"
                  >
                    {sortedHistory.map((r) => (
                      <option key={r.id} value={r.id}>
                        #{r.revision_no} — {r.title}
                      </option>
                    ))}
                  </select>
                </div>
                {diffFrom !== null && diffTo !== null && diffFrom.id !== diffTo.id ? (
                  <RevisionDiff from={diffFrom} to={diffTo} />
                ) : (
                  <p className="text-[11px] text-muted">pick two different revisions to diff</p>
                )}
              </div>
            )}
            <PublishForm
              onPublish={(input) => {
                void k.actions.publish(input, target).then(() => {
                  // A published draft stops being a draft: put it in the URL
                  // so a refresh lands on the node instead of a blank draft.
                  setDraftId(null);
                  onSelectNode(target);
                });
              }}
              publishing={k.publishing}
              disabled={k.taxonomy === null}
              disabledReason={
                k.taxonomy === null
                  ? "Seed the reserved vocabularies first — a revision needs exactly one type term."
                  : undefined
              }
              editingNode={k.head?.revision != null}
            />
          </>
        )}
        {k.error !== null && (
          <div className="p-3">
            <ErrorNote error={{ code: "refused", message: k.error }} />
          </div>
        )}
      </main>

      <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-l border-edge p-3">
        <TaxonomySetup
          ids={k.taxonomy}
          seeded={k.taxonomy !== null}
          onSeed={() => void k.actions.seed()}
          busy={k.busy}
          error={null}
        />
        {k.allTerms.length === 0 ? (
          <TermCloudEmpty />
        ) : (
          <TermCloud terms={k.allTerms} onSelect={setTermFilter} selected={termFilter} />
        )}
      </aside>
    </div>
  );
}
