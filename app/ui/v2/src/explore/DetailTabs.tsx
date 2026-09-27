import { TYPE_TERMS, type TypeTerm } from "../api/knowledge";
import type { NodeRow } from "../api/listing";
import type { ChatAnswer, MessageRow as MessageRowType } from "../api/memory";
import type { TaxonomyIds } from "../api/knowledge";
import type { CitedRevisionStatus, CitingNodeStatus } from "../state/evidenceStatus.types";
import type {
  AssociationResult,
  DependentOccurrence,
  LifecycleEventRow,
  LifecycleWriteOutcome,
  RecallEligibility,
  SessionLinkRow,
  TraceHitRow,
  TraceRow,
} from "../api/evidenceReview";
import { DialecticPanel } from "../components/DialecticPanel";
import { Composer } from "../components/Composer";
import { Transcript } from "../components/Transcript";
import { TaxonomySetup } from "../components/TaxonomySetup";
import { KnowledgeSearchBox } from "../components/KnowledgeSearchBox";
import { KnowledgeSearchResults } from "../components/KnowledgeSearchResults";
import type { SearchMode } from "../state/useKnowledgeSearch";
import type { KeywordHitWire, SemanticHitWire } from "../state/searchHitView";
import { TracePanel } from "../components/TracePanel";
import { SessionLinksPanel } from "../components/SessionLinksPanel";
import { LifecyclePanel } from "../components/LifecyclePanel";
import { LifecycleActions } from "../components/LifecycleActions";
import { AssociationPanel } from "../components/AssociationPanel";
import { DependentsPanel } from "../components/DependentsPanel";
import { ListPanel } from "./ListPanel";

export type ExploreTab = "nodes" | "search" | "chat" | "messages" | "evidence" | "config";
export const EXPLORE_TABS: ExploreTab[] = ["nodes", "search", "chat", "messages", "evidence", "config"];

/** The right-hand detail panel. Six tabs, one already-fetched-elsewhere
 *  view each -- this component switches between them and lays them out; it
 *  fetches nothing itself, matching `Transcript`/`DialecticPanel`'s own
 *  presentational contract. Chat and Messages are the EXISTING dialectic and
 *  transcript components wired to whatever peer/session the caller has
 *  selected, not reimplementations -- the point of reuse here is that a bug
 *  fixed in the messages view upstream is fixed here too, for free.
 */
export function DetailTabs(props: {
  active: ExploreTab;
  onChange: (t: ExploreTab) => void;
  nodes: {
    rows: NodeRow[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    typeTerm: TypeTerm | null;
    onTypeTerm: (t: TypeTerm | null) => void;
    /** #29 slice B: "show history" -- false excludes retired/superseded
     *  nodes (the ordinary view); true includes them, labelled. */
    includeInactive: boolean;
    onIncludeInactive: (v: boolean) => void;
    loading: boolean;
    error: string | null;
    supported: boolean;
    total: string | null;
    pageIndex: number;
    hasNext: boolean;
    hasPrev: boolean;
    onNext: () => void;
    onPrev: () => void;
    onRefresh: () => void;
  };
  chat: {
    onAsk: (q: string, maxItems: number) => void;
    answer: ChatAnswer | null;
    asking: boolean;
    error: string | null;
    disabled: boolean;
    disabledReason: string | null;
  };
  messages: {
    rows: MessageRowType[];
    sessionName: string | null;
    loading: boolean;
    error: string | null;
    sending: boolean;
    peerName: string;
    onSend: (peer: string, role: string | null, content: string) => void;
    onLoadMore: () => void;
    disabled: boolean;
    disabledReason: string | null;
  };
  evidence: {
    nodeId: string | null;
    sessionName: string | null;
    headRevisionId: string | null;
    trace: {
      id: string;
      onIdChange: (id: string) => void;
      onLookup: () => void;
      loading: boolean;
      row: TraceRow | null;
      error: string | null;
    };
    hits: {
      rows: TraceHitRow[];
      error: string | null;
      hasMore: boolean;
      onLoadMore: () => void;
    };
    sessionLinks: {
      rows: SessionLinkRow[];
      loading: boolean;
      error: string | null;
      hasMore: boolean;
      onLoadMore: () => void;
      direction: "from" | "to";
      onDirectionChange: (d: "from" | "to") => void;
    };
    lifecycle: {
      rows: LifecycleEventRow[];
      loading: boolean;
      error: string | null;
    };
    recall: {
      value: RecallEligibility | null;
      error: string | null;
    };
    lifecycleActions: {
      busy: boolean;
      error: string | null;
      outcome: LifecycleWriteOutcome | null;
      onRetire: (expectedRevisionId: string, reason: string) => void;
      onSupersede: (expectedRevisionId: string, newNodeId: string, newRevisionId: string, reason: string) => void;
    };
    association: {
      row: AssociationResult | null;
      loading: boolean;
      error: string | null;
      citedStatus: ReadonlyMap<string, CitedRevisionStatus>;
    };
    dependents: {
      rows: DependentOccurrence[];
      loading: boolean;
      error: string | null;
      hasMore: boolean;
      onLoadMore: () => void;
      citingStatus: ReadonlyMap<string, CitingNodeStatus>;
    };
  };
  config: {
    taxonomy: TaxonomyIds | null;
    seeded: boolean;
    onSeed: () => void;
    busy: boolean;
    error: string | null;
  };
  search: {
    query: string;
    onQuery: (q: string) => void;
    mode: SearchMode;
    onMode: (m: SearchMode) => void;
    loading: boolean;
    errorCode: string | null;
    hits: (KeywordHitWire | SemanticHitWire)[];
    scanReason: "short_query" | "index_unavailable" | null;
    embeddingProfile: string | null;
    onOpenNode: (nodeId: string) => void;
  };
}) {
  const { active, onChange } = props;
  return (
    // `min-w-0`: this panel is a flex item of ExploreView's row, and without
    // it one long unbreakable line (a code target's path, measured: 1,807px)
    // set the panel's minimum width and pushed the whole page sideways.
    //
    // #33 AC2 round 3: below `lg` ExploreView stacks the lists above this
    // pane and scrolls the page, so the pane is a `shrink-0` region with a
    // viewport-relative height (never squeezed -- round 2's `flex-1 min-h-0`
    // measured 0px at 375x812) and the tab bodies scroll inside it. From `lg`
    // it is the row's `flex-1` again, stretched to the row's height.
    // Round 4: `max-h-full` caps it at the page scroller's own height, so
    // scrolled into view the tab bar, transcript and composer fit on one
    // screen. The 24rem floor still wins where the scroller is shorter (a
    // landscape phone, 812x375: 384px in a 211px scrollport) -- measured,
    // capping the floor too left the transcript 24px tall there.
    <section
      aria-label="Explore detail"
      className="flex h-[80vh] max-h-full min-h-[24rem] min-w-0 shrink-0 flex-col lg:h-auto lg:min-h-0 lg:flex-1 lg:shrink"
    >
      <div className="flex flex-wrap gap-1 border-b border-edge px-2 py-1.5">
        {EXPLORE_TABS.map((t) => (
          <button
            key={t}
            onClick={() => onChange(t)}
            className={`rounded px-2.5 py-1 text-xs capitalize ${
              active === t ? "bg-accent/15 text-accent" : "text-muted hover:text-slate-200"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {active === "nodes" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 px-3 py-2">
            <label htmlFor="explore-type-filter" className="text-[11px] text-muted">
              type
            </label>
            <select
              id="explore-type-filter"
              value={props.nodes.typeTerm ?? ""}
              onChange={(e) => props.nodes.onTypeTerm(e.target.value === "" ? null : (e.target.value as TypeTerm))}
              className="rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
            >
              <option value="">all types</option>
              {TYPE_TERMS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            {/* #29 slice B: default excludes retired/superseded nodes;
                checking this asks for the history view instead. */}
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={props.nodes.includeInactive}
                onChange={(e) => props.nodes.onIncludeInactive(e.target.checked)}
                className="accent-accent"
              />
              show history
            </label>
          </div>
          {/* Same list shell as the left column's peers/sessions -- one
              node row rendered as "type · title · rev N" since ListPanel's
              row slot is plain text, not a badge layout. A retired or
              superseded row (only ever seen with "show history" checked)
              gets its lifecycle state appended, so it never looks like an
              ordinary active node. */}
          <ListPanel<NodeRow>
            label="nodes"
            rows={props.nodes.rows}
            rowKey={(n) => n.id}
            renderRow={(n) =>
              n.lifecycle_state === "active"
                ? `${n.title} · rev ${n.revision_no}`
                : `${n.title} · rev ${n.revision_no} · ${n.lifecycle_state}` +
                  (n.new_id !== null ? ` → ${n.new_id}` : "")
            }
            selectedKey={props.nodes.selectedId}
            onSelect={(n) => props.nodes.onSelect(n.id)}
            loading={props.nodes.loading}
            error={props.nodes.error}
            supported={props.nodes.supported}
            total={props.nodes.total}
            pageIndex={props.nodes.pageIndex}
            hasNext={props.nodes.hasNext}
            hasPrev={props.nodes.hasPrev}
            onNext={props.nodes.onNext}
            onPrev={props.nodes.onPrev}
            onRefresh={props.nodes.onRefresh}
          />
        </div>
      )}

      {active === "search" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <KnowledgeSearchBox
            query={props.search.query}
            onQuery={props.search.onQuery}
            mode={props.search.mode}
            onMode={props.search.onMode}
          />
          <KnowledgeSearchResults
            query={props.search.query}
            mode={props.search.mode}
            loading={props.search.loading}
            errorCode={props.search.errorCode}
            hits={props.search.hits}
            scanReason={props.search.scanReason}
            embeddingProfile={props.search.embeddingProfile}
            onOpenNode={props.search.onOpenNode}
          />
        </div>
      )}

      {active === "chat" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DialecticPanel
            onAsk={props.chat.onAsk}
            answer={props.chat.answer}
            asking={props.chat.asking}
            error={props.chat.error}
            disabled={props.chat.disabled}
            disabledReason={props.chat.disabledReason}
          />
        </div>
      )}

      {active === "messages" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <Transcript
            messages={props.messages.rows}
            loading={props.messages.loading}
            error={props.messages.error}
            selectedSession={props.messages.sessionName}
            highlighted={new Set()}
            onLoadMore={props.messages.onLoadMore}
            hasMore={false}
          />
          <Composer
            peerName={props.messages.peerName}
            onSend={props.messages.onSend}
            sending={props.messages.sending}
            disabled={props.messages.disabled}
            disabledReason={props.messages.disabledReason}
          />
        </div>
      )}

      {active === "evidence" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <TracePanel
            traceId={props.evidence.trace.id}
            onTraceIdChange={props.evidence.trace.onIdChange}
            onLookup={props.evidence.trace.onLookup}
            loading={props.evidence.trace.loading}
            trace={props.evidence.trace.row}
            error={props.evidence.trace.error}
            hits={props.evidence.hits.rows}
            hitsError={props.evidence.hits.error}
            hasMoreHits={props.evidence.hits.hasMore}
            onLoadMoreHits={props.evidence.hits.onLoadMore}
          />
          <SessionLinksPanel
            sessionName={props.evidence.sessionName}
            direction={props.evidence.sessionLinks.direction}
            onDirectionChange={props.evidence.sessionLinks.onDirectionChange}
            rows={props.evidence.sessionLinks.rows}
            loading={props.evidence.sessionLinks.loading}
            error={props.evidence.sessionLinks.error}
            hasMore={props.evidence.sessionLinks.hasMore}
            onLoadMore={props.evidence.sessionLinks.onLoadMore}
          />
          <AssociationPanel
            row={props.evidence.association.row}
            loading={props.evidence.association.loading}
            error={props.evidence.association.error}
            citedStatus={props.evidence.association.citedStatus}
          />
          <DependentsPanel
            rows={props.evidence.dependents.rows}
            loading={props.evidence.dependents.loading}
            error={props.evidence.dependents.error}
            hasMore={props.evidence.dependents.hasMore}
            onLoadMore={props.evidence.dependents.onLoadMore}
            citingStatus={props.evidence.dependents.citingStatus}
          />
          <LifecyclePanel
            nodeId={props.evidence.nodeId}
            recall={props.evidence.recall.value}
            recallError={props.evidence.recall.error}
            history={props.evidence.lifecycle.rows}
            loading={props.evidence.lifecycle.loading}
            error={props.evidence.lifecycle.error}
          />
          {/* Keyed by node: a retire/supersede form opened (and half filled)
              on node A must not survive into node B and be confirmed there. */}
          <LifecycleActions
            key={props.evidence.nodeId ?? "none"}
            nodeId={props.evidence.nodeId}
            expectedRevisionId={props.evidence.headRevisionId}
            busy={props.evidence.lifecycleActions.busy}
            error={props.evidence.lifecycleActions.error}
            outcome={props.evidence.lifecycleActions.outcome}
            onRetire={props.evidence.lifecycleActions.onRetire}
            onSupersede={props.evidence.lifecycleActions.onSupersede}
          />
        </div>
      )}

      {active === "config" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <TaxonomySetup
            ids={props.config.taxonomy}
            seeded={props.config.seeded}
            onSeed={props.config.onSeed}
            busy={props.config.busy}
            error={props.config.error}
          />
        </div>
      )}
    </section>
  );
}
