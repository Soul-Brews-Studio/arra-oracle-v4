import { TYPE_TERMS, type TypeTerm } from "../api/knowledge";
import type { NodeRow } from "../api/listing";
import type { ChatAnswer, MessageRow as MessageRowType } from "../api/memory";
import type { TaxonomyIds } from "../api/knowledge";
import type { LifecycleEventRow, RecallEligibility, SessionLinkRow, TraceHitRow, TraceRow } from "../api/evidenceReview";
import { DialecticPanel } from "../components/DialecticPanel";
import { Composer } from "../components/Composer";
import { Transcript } from "../components/Transcript";
import { TaxonomySetup } from "../components/TaxonomySetup";
import { TracePanel } from "../components/TracePanel";
import { SessionLinksPanel } from "../components/SessionLinksPanel";
import { LifecyclePanel } from "../components/LifecyclePanel";
import { ListPanel } from "./ListPanel";

export type ExploreTab = "nodes" | "chat" | "messages" | "evidence" | "config";
export const EXPLORE_TABS: ExploreTab[] = ["nodes", "chat", "messages", "evidence", "config"];

/** The right-hand detail panel. Five tabs, one already-fetched-elsewhere
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
  };
  config: {
    taxonomy: TaxonomyIds | null;
    seeded: boolean;
    onSeed: () => void;
    busy: boolean;
    error: string | null;
  };
}) {
  const { active, onChange } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 border-b border-edge px-2 py-1.5">
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
            <label className="text-[11px] text-muted">type</label>
            <select
              value={props.nodes.typeTerm ?? ""}
              onChange={(e) => props.nodes.onTypeTerm(e.target.value === "" ? null : (e.target.value as TypeTerm))}
              className="rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
            >
              <option value="">all types</option>
              {TYPE_TERMS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          {/* Same list shell as the left column's peers/sessions -- one
              node row rendered as "type · title · rev N" since ListPanel's
              row slot is plain text, not a badge layout. */}
          <ListPanel<NodeRow>
            label="nodes"
            rows={props.nodes.rows}
            rowKey={(n) => n.id}
            renderRow={(n) => `${n.title} · rev ${n.revision_no}`}
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
          />
          <LifecyclePanel
            nodeId={props.evidence.nodeId}
            recall={props.evidence.recall.value}
            recallError={props.evidence.recall.error}
            history={props.evidence.lifecycle.rows}
            loading={props.evidence.lifecycle.loading}
            error={props.evidence.lifecycle.error}
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
    </div>
  );
}
