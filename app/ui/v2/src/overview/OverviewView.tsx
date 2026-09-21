import { useMemo } from "react";
import type { Bank } from "../api/memory";
import { SAMPLE_LIMIT, type Count } from "../api/overview";
import type { Route } from "../state/useRoute";
import { useOverview } from "../state/useOverview";
import { HealthLine } from "./HealthLine";
import { ProbeTable } from "./ProbeTable";
import { QuickActions } from "./QuickActions";
import { StatCard, statFromCount } from "./StatCard";
import { StatGrid } from "./StatGrid";
import { TypeBreakdown, type TypeCounts } from "./TypeBreakdown";

/** The landing page: every number this server can produce, each sitting beside
 *  the call that produced it.
 *
 * It owns no fetching. `state/useOverview` fires the whole volley and hands
 * back a `Count` per card carrying its own outcome, which is what lets one
 * dead method grey one card instead of blanking the screen. This file only
 * decides what each number MEANS -- whether a zero is an empty workspace or a
 * zero that can never move.
 */

// Two measured zeros that need a sentence, and it has to be on the card: both
// numbers are real, and both answer a different question than their label
// implies -- without this a reader takes "0 mcp calls" as "nobody used the
// tools", and acts on it. Both are worded as claims about a COUNT, so both go
// through `whenCounted`: they are false the moment nothing counted.
const MCP_WHY =
  "really counted, but mcp_calls are written under ARRA_DATA_DIR while this read opens ARRA_KNOWLEDGE_DATASET_ROOT — it stays 0 however much the server is used";
const CONNECTION_WHY =
  "really counted, but nothing anywhere in the codebase writes a connection row yet — it stays 0 until a writer exists";

/** `statFromCount` maps the outcome; this only replaces its `meta`, which
 *  would otherwise lead with an em dash standing in for an HTTP status the
 *  listing layer never carried -- and the duration IS known. See `ProbeTable`. */
function probe(count: Count) {
  return { ...statFromCount(count), meta: `${count.durationMs} ms` };
}

/** "1 session", not "1 sessions" -- decided by comparing the wire TEXT to
 *  "1", since Int64 arrives canonical and a plural is not worth the one
 *  `Number()` that would put a parse back into this page. */
const plural = (total: string | null, noun: string) => `${total ?? "—"} ${noun}${total === "1" ? "" : "s"}`;

/** A subline that ASSERTS a measurement has to disappear with the
 *  measurement. `tone` and `hint` already switch on the outcome; `sub` was the
 *  one prop left as a literal, so a failed probe printed an em dash with the
 *  word "counted" under it -- and the ⚠ glyph, correctly dropped in that
 *  state, took the only contradicting signal with it. */
const whenCounted = (count: Count, sub: string): string | null => (count.outcome === "counted" ? sub : count.note);

export function OverviewView({ bank, onGo }: { bank: Bank; onGo: (view: Route["view"]) => void }) {
  // Memoised HERE rather than trusting the caller. `useOverview` re-probes
  // whenever its bank object changes identity, so a parent that builds one
  // inline -- App.tsx does, for every view -- would re-fire eleven requests on
  // every render and never settle.
  const b = useMemo<Bank>(() => bank, [bank.bank, bank.workspace, bank.token]); // eslint-disable-line react-hooks/exhaustive-deps
  const o = useOverview(b);
  const c = o.counts;

  // Keyed, because `TypeBreakdown` renders a term with no entry as "not
  // probed" rather than letting it vanish; the hook hands back the volley's array.
  const byType = useMemo(() => Object.fromEntries(o.byType.map((t) => [t.term, t])) as TypeCounts, [o.byType]);

  const sessionSub =
    o.derived.activeSessions === null
      ? "— active · no complete page to count"
      : `${o.derived.activeSessions} of ${c.sessions.total ?? "—"} active`;
  const revisionSub =
    o.derived.revisions === null ? "— revisions · no complete page to sum" : plural(o.derived.revisions, "revision");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <HealthLine
        bank={b.bank}
        workspace={b.workspace}
        version={o.health?.version ?? null}
        auth={o.health?.auth ?? null}
        probedAt={o.probedAt === null ? null : o.probedAt.toLocaleTimeString()}
        requestCount={o.requests}
        elapsedMs={o.probedAt === null ? null : o.elapsedMs}
        onRefreshAll={o.refresh}
        refreshing={o.loading}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {o.error !== null && (
          <p className="text-[11px] text-[#f0a35e]">{o.error} — the cards below say which one, and why</p>
        )}

        <StatGrid
          label={
            <span>
              <span className="font-semibold uppercase tracking-wide">arra overview</span> · every number the server can
              produce, beside the call that produced it
            </span>
          }>
          <StatCard label="peers" {...probe(c.peers)} sub="native COUNT over the workspace" />
          <StatCard label="sessions" {...probe(c.sessions)} sub={sessionSub} />
          <StatCard label="nodes" {...probe(c.nodes)} sub={revisionSub} />
          <StatCard
            label="mcp calls"
            {...probe(c.mcpCalls)}
            tone={c.mcpCalls.outcome === "counted" ? "warn" : "normal"}
            hint={c.mcpCalls.note ?? MCP_WHY}
            sub={whenCounted(c.mcpCalls, "counted, but the writer uses a different data dir")}
          />
          <StatCard
            label="connections"
            {...probe(c.connections)}
            tone={c.connections.outcome === "counted" ? "warn" : "normal"}
            hint={c.connections.note ?? CONNECTION_WHY}
            sub={whenCounted(c.connections, "counted, but no writer exists anywhere yet")}
          />
        </StatGrid>

        <TypeBreakdown counts={byType} nodesTotal={c.nodes.total} limit={SAMPLE_LIMIT} />

        <div className="grid grid-cols-[repeat(auto-fit,minmax(20rem,1fr))] items-start gap-3">
          <ProbeTable counts={c} byType={o.byType} byTypeCheck={o.byTypeCheck} health={o.health} />
          <QuickActions
            onGo={onGo}
            details={{
              explore: `${plural(c.peers.total, "peer")} · ${plural(c.sessions.total, "session")} · ${plural(c.nodes.total, "node")}`,
              knowledge: `${plural(c.nodes.total, "node")} · ${plural(o.derived.revisions, "revision")}`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
