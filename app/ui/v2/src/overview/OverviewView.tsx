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

// What the two audit counts actually count. Until R5 (#103/#102) both were
// zeros that could never move -- the reads opened a dataset nothing wrote to --
// and these lines said so. The readers now open the operations root the
// writers fill, so the numbers are live; what still needs saying is their
// SCOPE. Since #31's audit parity (2026-09-27) an admitted knowledge call is
// logged and folded on HTTP (`POST /api/knowledge/…`, which the CLI's `kb`
// uses) exactly as on MCP, and since the legacy-audit slice so are the legacy
// memory routes, as their MCP twins; the global maintenance routes (backfill,
// reindex) and any request refused before admission (no or bad token, no
// grant) still move neither. Both are
// claims about a COUNT, so both go through `whenCounted`: they are false the
// moment nothing counted.
const MCP_WHY =
  "admitted MCP tools/call, HTTP knowledge API (/api/knowledge) and legacy HTTP memory route (/api/memories, /api/search, /api/health) calls in this workspace, successes and failures, read from the operations root (ARRA_DATA_DIR) the call log is written to — the global maintenance routes (/api/backfill, /api/reindex) and requests refused before admission are not logged here";
const CONNECTION_WHY =
  "distinct callers in this workspace — one row per credential and client label, folded from each admitted MCP tools/call, HTTP knowledge API or legacy HTTP memory route call — maintenance route callers and unauthenticated requests are not counted";

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
            hint={c.mcpCalls.note ?? MCP_WHY}
            sub={whenCounted(c.mcpCalls, "admitted MCP + HTTP knowledge calls · legacy routes not logged")}
          />
          <StatCard
            label="connections"
            {...probe(c.connections)}
            hint={c.connections.note ?? CONNECTION_WHY}
            sub={whenCounted(c.connections, "distinct callers · credential + client label")}
          />
        </StatGrid>

        <TypeBreakdown counts={byType} nodesTotal={c.nodes.total} limit={SAMPLE_LIMIT} />

        {/* `min(20rem,100%)`: a bare 20rem track is 320px before this view's
            padding, so at 320px the probe card overflowed (#33 AC2 round 4). */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] items-start gap-3">
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
