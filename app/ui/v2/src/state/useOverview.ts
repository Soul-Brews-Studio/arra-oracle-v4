/** Everything the overview page asks the server, fired as ONE parallel volley:
 *  five counts, five per-type node counts, and the public `/health` ping --
 *  eleven requests, so the page can honestly say how many it made and how long
 *  they took.
 *
 * Parallel rather than sequential because none of them depends on another, and
 * because a serial chain turns one slow probe into a slow page. The cost is
 * that a half-failed volley is normal: each `Count` carries its own outcome, so
 * one dead method greys one card instead of blanking the page.
 *
 * Nothing in here ever turns an unknown into a zero. A count is `string | null`
 * where null means pending, failed, or absent -- which of the three is in
 * `Count.outcome`, and the reason in `Count.note`. Everything DERIVED from a
 * volley lives in `overviewDerive.ts`, which follows the same rule.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { health } from "../api/client";
import { TYPE_TERMS } from "../api/knowledge";
import { type NodeRow, type SessionRow, listNodes, listPeers, listSessions } from "../api/listing";
import { type Bank } from "../api/memory";
import { type Count, countOnly, countWithSample, pendingCount } from "../api/overview";
import { listConnections, listMcpCalls } from "../api/audit";
import { type TypeCount, countByType, resolveByType } from "../api/typeCount";
import {
  type ByTypeCheck, type HealthInfo, type PageDerived,
  deriveByTypeCheck, derivePage, toHealth,
} from "./overviewDerive";

export type OverviewCounts = {
  peers: Count; sessions: Count; nodes: Count; mcpCalls: Count; connections: Count;
};

export type OverviewState = {
  counts: OverviewCounts;
  byType: TypeCount[];
  byTypeCheck: ByTypeCheck;
  derived: PageDerived;
  health: HealthInfo | null;
  loading: boolean;
  error: string | null;
  probedAt: Date | null;
  requests: number;
  elapsedMs: number;
};

const REQUESTS = 5 + TYPE_TERMS.length + 1;

const INITIAL: OverviewState = {
  counts: {
    peers: pendingCount("listPeers"),
    sessions: pendingCount("listSessions"),
    nodes: pendingCount("listNodes"),
    mcpCalls: pendingCount("listMcpCalls"),
    connections: pendingCount("listConnections"),
  },
  byType: [],
  byTypeCheck: { sum: null, allExact: false, matchesTotal: null },
  derived: { activeSessions: null, revisions: null },
  health: null,
  loading: false,
  error: null,
  probedAt: null,
  requests: REQUESTS,
  elapsedMs: 0,
};

export function useOverview(b: Bank) {
  // Which volley is current. A run that finishes after the bank or token
  // changed must not land: it would paint one workspace's numbers under
  // another's name, and every number on this page is a claim about a scope.
  const volley = useRef(0);
  const [state, setState] = useState<OverviewState>(INITIAL);

  const refresh = useCallback(() => {
    const id = ++volley.current;
    setState((s) => ({ ...s, loading: true }));
    const started = performance.now();
    void (async () => {
      const [peers, sessions, nodes, mcpCalls, connections, rawByType, ping] = await Promise.all([
        countOnly("listPeers", (limit, inc) => listPeers(b, null, limit, inc)),
        // Sessions and nodes take a full page rather than one row: their cards
        // show a subline the server cannot compute (active count, revision
        // sum), and the same request carries both the total and the rows.
        countWithSample<SessionRow>("listSessions", (limit, inc) => listSessions(b, null, limit, inc)),
        // `include_inactive: false`: the overview counts the ordinary,
        // current view (#29 slice B) -- history mode is an EXPLORE-only toggle.
        countWithSample<NodeRow>("listNodes", (limit, inc) => listNodes(b, null, limit, inc, null, false)),
        countOnly("listMcpCalls", (limit, inc) => listMcpCalls(b, null, limit, inc, null, null)),
        countOnly("listConnections", (limit, inc) => listConnections(b, null, limit, inc)),
        Promise.all(TYPE_TERMS.map((term) => countByType(b, term))),
        // `/health` is the PUBLIC route and takes no token -- see `client.ts`
        // for why the gated `/api/health` is the wrong one to ping with.
        health(b.bank),
      ]);
      if (id !== volley.current) return;
      const counts: OverviewCounts = {
        peers, sessions: sessions.count, nodes: nodes.count, mcpCalls, connections,
      };
      // A filtered listNodes carries no total, so a failed one looks exactly
      // like an empty one -- the unfiltered probe beside it is what tells
      // them apart, and it is only available here, after the volley.
      const byType = resolveByType(rawByType, counts.nodes);
      // Counted only where the outcome says the server answered. A probe that
      // is `absent` is not a failure to retry, and `pending` cannot fail.
      // Per-type calls are missing from this tally on purpose: a filtered
      // listNodes returns no total, so a failed one is not detectable here.
      const failed = Object.values(counts).filter((c) => c.outcome === "failed").length + (ping.ok ? 0 : 1);
      setState({
        counts,
        byType,
        byTypeCheck: deriveByTypeCheck(byType, counts.nodes.total),
        derived: derivePage(sessions, nodes),
        health: toHealth(ping),
        loading: false,
        error: failed === 0 ? null : `${failed} of ${REQUESTS} probes failed`,
        probedAt: new Date(),
        requests: REQUESTS,
        elapsedMs: Math.round(performance.now() - started),
      });
    })();
  }, [b]);

  // `b` is memoised on bank/workspace/token in `useMemory`, so this re-probes
  // exactly when the scope or the credential changes and not on every render.
  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh };
}
