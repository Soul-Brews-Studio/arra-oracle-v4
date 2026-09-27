import { useEffect } from "react";
import type { Bank } from "../api/memory";
import type { TypeTerm } from "../api/knowledge";
import { useListing } from "../state/useListing";
import { useMemory } from "../state/useMemory";
import { useKnowledge } from "../state/useKnowledge";
import { useEvidenceReview } from "../state/useEvidenceReview";
import { useKnowledgeSearch, type SearchMode } from "../state/useKnowledgeSearch";
import { searchRouteState } from "../state/searchRouteState";
import { CountStrip } from "./CountStrip";
import { ListPanel } from "./ListPanel";
import { DetailTabs, type ExploreTab } from "./DetailTabs";

/** The browsable peers/sessions/nodes screen, modelled on Honcho's Explore:
 *  two stacked lists on the left with live counts, a tabbed detail panel on
 *  the right. What a Honcho dashboard opens on for free (`listPeers`,
 *  `listSessions`) this app asks for through the three brand-new listing
 *  endpoints in `api/listing.ts` -- see that file for why a server without
 *  them must not read as "workspace is empty".
 *
 * Selection is passed in and pushed out through props, not owned here --
 * the same contract `KnowledgeView` already has with `App.tsx`/`useRoute`
 * (`nodeId` in, `onSelectNode` out). That is what makes a link to a
 * specific peer or tab restorable on refresh: whichever component wires
 * this one into the URL is the single place that has to get it right.
 *
 * `useMemory()`/`useKnowledge()` are the SAME hooks the messages and
 * knowledge tabs already use -- Chat/Messages/Config reuse their fetching
 * via `setBank`/`setWorkspace`/`setToken` and `setPeer`/`setSession` kept
 * in sync with this view's `bank` prop and selection below, instead of a
 * second implementation of `listMessages`/`getContext`/`answerChat`. */
export function ExploreView({
  bank,
  selectedPeer,
  selectedSession,
  selectedNode,
  activeTab,
  onSelectPeer,
  onSelectSession,
  onSelectNode,
  onTabChange,
  onBack,
  onOpenSearchHit,
  searchQuery,
  searchMode,
  onSearchChange,
}: {
  bank: Bank;
  selectedPeer: string | null;
  selectedSession: string | null;
  selectedNode: string | null;
  activeTab: ExploreTab;
  onSelectPeer: (name: string | null) => void;
  onSelectSession: (name: string | null) => void;
  onSelectNode: (id: string | null) => void;
  onTabChange: (t: ExploreTab) => void;
  onBack: () => void;
  /** Fix-round finding: opens the EXISTING node view (`KnowledgeView`,
   *  `#/knowledge?node=…`), not this view's own "nodes" tab -- see
   *  `state/searchHitRoute.ts` for why that tab is the wrong destination. */
  onOpenSearchHit: (nodeId: string) => void;
  /** The search tab's persisted state (fix-round finding, PR #110 follow-up
   *  #2) -- read from the route on mount via `searchRouteState`, same
   *  `selectedPeer`/`selectedNode` contract as the rest of this view. */
  searchQuery: string | null;
  searchMode: string | null;
  onSearchChange: (query: string, mode: SearchMode) => void;
}) {
  const listing = useListing(bank);
  const k = useKnowledge(bank);
  const m = useMemory();
  const evidence = useEvidenceReview(bank, selectedNode, selectedSession, selectedPeer);
  // `onSearchChange` (-> `replace(searchRoutePatch(...))`) is now passed
  // straight into the hook instead of being driven by a second `useEffect`
  // here keyed on `search.query`/`search.mode` (round-3 verifier blocking
  // finding): that effect and the hook's own routed-sync effect raced on
  // every Back/Forward that changed `activeTab` and the routed query in the
  // same commit, each undoing the other's write forever. See
  // `useKnowledgeSearch`'s header comment for the fix.
  //
  // This also fixes the round-3 non-blocking finding for free: the write
  // only ever happens from `setQuery`/`setMode`, which only the search
  // tab's own input and mode toggle call (`DetailTabs` doesn't render them
  // outside `active === "search"`) -- so switching to e.g. "nodes" can no
  // longer leak a `mode=keyword` into the URL the way the old effect did on
  // every mount.
  const search = useKnowledgeSearch(bank, searchRouteState({ q: searchQuery, mode: searchMode }), onSearchChange);

  useEffect(() => {
    m.setBank(bank.bank);
    m.setWorkspace(bank.workspace);
    m.setToken(bank.token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank.bank, bank.workspace, bank.token]);

  useEffect(() => {
    if (m.peer !== selectedPeer) m.setPeer(selectedPeer);
    if (m.session !== selectedSession) m.setSession(selectedSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPeer, selectedSession]);

  useEffect(() => {
    if (k.selected !== selectedNode) k.setSelected(selectedNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode]);

  const needBoth =
    selectedPeer === null && selectedSession === null
      ? "Pick a peer and a session."
      : selectedPeer === null
        ? "Pick a peer."
        : selectedSession === null
          ? "Pick a session."
          : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2 text-xs text-muted">
        <span>Workspaces</span>
        <span>&gt;</span>
        <span className="text-slate-100">{bank.workspace}</span>
        <button
          onClick={onBack}
          className="ml-auto rounded border border-edge px-2 py-1 text-muted hover:border-accent hover:text-accent"
        >
          Back
        </button>
      </div>

      <CountStrip
        peersTotal={listing.peers.state.total}
        sessionsTotal={listing.sessions.state.total}
        nodesTotal={listing.nodes.state.total}
        onRefreshAll={listing.refreshAll}
        refreshing={listing.peers.state.loading || listing.sessions.state.loading || listing.nodes.state.loading}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-edge">
          <ListPanel
            label="peers"
            rows={listing.peers.state.rows}
            rowKey={(p) => p.name}
            renderRow={(p) => p.name}
            selectedKey={selectedPeer}
            onSelect={(p) => onSelectPeer(p.name)}
            loading={listing.peers.state.loading}
            error={listing.peers.state.error}
            supported={listing.peers.state.supported}
            total={listing.peers.state.total}
            pageIndex={listing.peers.state.pageIndex}
            hasNext={listing.peers.state.hasNext}
            hasPrev={listing.peers.state.hasPrev}
            onNext={listing.peers.next}
            onPrev={listing.peers.prev}
            onRefresh={listing.peers.refresh}
          />
          <ListPanel
            label="sessions"
            rows={listing.sessions.state.rows}
            rowKey={(s) => s.name}
            renderRow={(s) => s.name}
            selectedKey={selectedSession}
            onSelect={(s) => onSelectSession(s.name)}
            loading={listing.sessions.state.loading}
            error={listing.sessions.state.error}
            supported={listing.sessions.state.supported}
            total={listing.sessions.state.total}
            pageIndex={listing.sessions.state.pageIndex}
            hasNext={listing.sessions.state.hasNext}
            hasPrev={listing.sessions.state.hasPrev}
            onNext={listing.sessions.next}
            onPrev={listing.sessions.prev}
            onRefresh={listing.sessions.refresh}
          />
        </div>

        <DetailTabs
          active={activeTab}
          onChange={onTabChange}
          nodes={{
            rows: listing.nodes.state.rows,
            selectedId: selectedNode,
            onSelect: onSelectNode,
            typeTerm: listing.typeTerm as TypeTerm | null,
            onTypeTerm: listing.setTypeTerm,
            includeInactive: listing.includeInactive,
            onIncludeInactive: listing.setIncludeInactive,
            loading: listing.nodes.state.loading,
            error: listing.nodes.state.error,
            supported: listing.nodes.state.supported,
            total: listing.nodes.state.total,
            pageIndex: listing.nodes.state.pageIndex,
            hasNext: listing.nodes.state.hasNext,
            hasPrev: listing.nodes.state.hasPrev,
            onNext: listing.nodes.next,
            onPrev: listing.nodes.prev,
            onRefresh: listing.nodes.refresh,
          }}
          chat={{
            onAsk: (q, n) => void m.actions.ask(q, n),
            answer: m.answer,
            asking: m.asking,
            error: m.askError,
            disabled: needBoth !== null,
            disabledReason: needBoth,
          }}
          messages={{
            rows: m.messages,
            sessionName: selectedSession,
            loading: m.loadingMessages,
            error: m.messageError,
            sending: m.sending,
            peerName: selectedPeer ?? "",
            onSend: (p, r, c) => void m.actions.send(p, r, c),
            onLoadMore: () => void m.actions.refreshMessages(),
            disabled: selectedSession === null,
            disabledReason: selectedSession === null ? "Pick a session first." : null,
          }}
          evidence={{
            nodeId: selectedNode,
            sessionName: selectedSession,
            headRevisionId: k.snapshotHead ?? k.head?.revision?.id ?? null,
            trace: {
              id: evidence.trace.id,
              onIdChange: evidence.trace.setId,
              onLookup: evidence.trace.lookup,
              loading: evidence.trace.loading,
              row: evidence.trace.row,
              error: evidence.trace.error,
            },
            hits: {
              rows: evidence.hits.rows,
              error: evidence.hits.error,
              hasMore: evidence.hits.hasMore,
              onLoadMore: evidence.hits.loadMore,
            },
            sessionLinks: {
              rows: evidence.sessionLinks.rows,
              loading: evidence.sessionLinks.loading,
              error: evidence.sessionLinks.error,
              hasMore: evidence.sessionLinks.hasMore,
              onLoadMore: evidence.sessionLinks.loadMore,
              direction: evidence.sessionLinks.direction,
              onDirectionChange: evidence.sessionLinks.setDirection,
            },
            lifecycle: {
              rows: evidence.lifecycle.rows,
              loading: evidence.lifecycle.loading,
              error: evidence.lifecycle.error,
            },
            recall: {
              value: evidence.recall.value,
              error: evidence.recall.error,
            },
            lifecycleActions: {
              busy: evidence.lifecycle.actions.busy,
              error: evidence.lifecycle.actions.error,
              outcome: evidence.lifecycle.actions.outcome,
              onRetire: evidence.lifecycle.actions.retire,
              onSupersede: evidence.lifecycle.actions.supersede,
            },
            association: {
              row: evidence.association.row,
              loading: evidence.association.loading,
              error: evidence.association.error,
              citedStatus: evidence.association.citedStatus,
            },
            dependents: {
              rows: evidence.dependents.rows,
              loading: evidence.dependents.loading,
              error: evidence.dependents.error,
              hasMore: evidence.dependents.hasMore,
              onLoadMore: evidence.dependents.loadMore,
              citingStatus: evidence.dependents.citingStatus,
            },
          }}
          config={{
            taxonomy: k.taxonomy,
            seeded: k.taxonomy !== null,
            onSeed: () => void k.actions.seed(),
            busy: k.busy,
            error: k.error,
          }}
          search={{
            query: search.query,
            onQuery: search.setQuery,
            mode: search.mode,
            onMode: search.setMode,
            loading: search.loading,
            errorCode: search.errorCode,
            hits: search.hits,
            scanReason: search.scanReason,
            embeddingProfile: search.embeddingProfile,
            // Fix-round finding: this used to `onSelectNode` + switch to the
            // "nodes" tab, which shows a paged, filterable list row at best
            // (nothing at all if the hit is off-page) and never the node's
            // title/body/history. `onOpenSearchHit` navigates to the actual
            // node view instead -- see `state/searchHitRoute.ts`.
            onOpenNode: onOpenSearchHit,
          }}
        />
      </div>
    </div>
  );
}
