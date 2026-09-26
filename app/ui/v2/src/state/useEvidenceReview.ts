/** Server state for the #33 "evidence review" surface: traces, session links
 *  and node lifecycle. Sibling of `useKnowledge`/`useMemory` -- same
 *  discipline, every request in this lane issued here, components stay
 *  presentational.
 *
 * Three independent lanes, refetched on three different triggers, because
 * the three kernels are scoped by three different identifiers (see
 * `api/evidenceReview.ts`'s header for why there is no single "evidence for
 * X"):
 *   - traces are looked up MANUALLY, by an id the caller must already hold
 *     (no `listTraces` exists yet -- a search/list surface is explicitly
 *     out of this slice's scope, per this issue's brief).
 *   - session links refetch whenever the selected SESSION changes.
 *   - lifecycle history and recall eligibility refetch whenever the
 *     selected NODE changes.
 */
import { useCallback, useEffect, useState } from "react";
import { type ApiResult } from "../api/client";
import { type Bank, asError } from "../api/memory";
import {
  type LifecycleEventRow,
  type RecallEligibility,
  type SessionLinkRow,
  type TraceHitRow,
  type TraceRow,
  getRecallEligibility,
  getTrace,
  hitsOf,
  lifecycleHistoryOf,
  listLifecycleHistory,
  listSessionLinks,
  listTraceHits,
  recallEligibilityOf,
  sessionLinksOf,
  traceOf,
} from "../api/evidenceReview";

const HITS_PAGE = 50;
const LINKS_PAGE = 50;
const LIFECYCLE_PAGE = 50;

function describe(result: ApiResult): string {
  if (result.error !== undefined) return result.error;
  const envelope = asError(result.body);
  if (envelope !== null) return String(envelope.code);
  return `HTTP ${result.status}`;
}

export function useEvidenceReview(b: Bank, nodeId: string | null, sessionName: string | null) {
  // ---- traces: manual lookup by id ---------------------------------------
  const [traceId, setTraceId] = useState("");
  const [trace, setTrace] = useState<TraceRow | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [hits, setHits] = useState<TraceHitRow[]>([]);
  const [hitsNextAfter, setHitsNextAfter] = useState<string | null>(null);
  const [hitsError, setHitsError] = useState<string | null>(null);

  const lookupTrace = useCallback(
    async (id: string) => {
      setTraceLoading(true);
      setTraceError(null);
      setHitsError(null);
      const traceResult = await getTrace(b, id);
      if (!traceResult.ok) {
        setTraceLoading(false);
        setTrace(null);
        setHits([]);
        setTraceError(describe(traceResult));
        return;
      }
      const found = traceOf(traceResult);
      setTrace(found);
      if (found === null) {
        // Not an error: `getTrace` answers `null` for an id it does not
        // have, same as `getAcceptedHead` for a node it does not have.
        setTraceLoading(false);
        setHits([]);
        return;
      }
      const hitsResult = await listTraceHits(b, id, null, HITS_PAGE);
      setTraceLoading(false);
      if (!hitsResult.ok) {
        setHits([]);
        setHitsError(describe(hitsResult));
        return;
      }
      const page = hitsOf(hitsResult);
      setHits(page.rows);
      setHitsNextAfter(page.nextAfterPosition);
    },
    [b],
  );

  const loadMoreHits = useCallback(async () => {
    if (trace === null || hitsNextAfter === null) return;
    const hitsResult = await listTraceHits(b, trace.id, hitsNextAfter, HITS_PAGE);
    if (!hitsResult.ok) {
      setHitsError(describe(hitsResult));
      return;
    }
    const page = hitsOf(hitsResult);
    setHits((prev) => [...prev, ...page.rows]);
    setHitsNextAfter(page.nextAfterPosition);
  }, [b, trace, hitsNextAfter]);

  // ---- session links: follow the selected session ------------------------
  const [linkDirection, setLinkDirection] = useState<"from" | "to">("from");
  const [sessionLinks, setSessionLinks] = useState<SessionLinkRow[]>([]);
  const [sessionLinksLoading, setSessionLinksLoading] = useState(false);
  const [sessionLinksError, setSessionLinksError] = useState<string | null>(null);

  const refreshSessionLinks = useCallback(async () => {
    if (sessionName === null) {
      setSessionLinks([]);
      setSessionLinksError(null);
      return;
    }
    setSessionLinksLoading(true);
    setSessionLinksError(null);
    const result = await listSessionLinks(b, sessionName, linkDirection, null, LINKS_PAGE);
    setSessionLinksLoading(false);
    if (!result.ok) {
      setSessionLinks([]);
      setSessionLinksError(describe(result));
      return;
    }
    setSessionLinks(sessionLinksOf(result).rows);
  }, [b, sessionName, linkDirection]);

  useEffect(() => {
    void refreshSessionLinks();
  }, [refreshSessionLinks]);

  // ---- lifecycle + recall eligibility: follow the selected node ----------
  const [lifecycle, setLifecycle] = useState<LifecycleEventRow[]>([]);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [recall, setRecall] = useState<RecallEligibility | null>(null);
  const [recallError, setRecallError] = useState<string | null>(null);

  const refreshLifecycle = useCallback(async () => {
    if (nodeId === null) {
      setLifecycle([]);
      setLifecycleError(null);
      setRecall(null);
      setRecallError(null);
      return;
    }
    setLifecycleLoading(true);
    setLifecycleError(null);
    setRecallError(null);
    const [historyResult, recallResult] = await Promise.all([
      listLifecycleHistory(b, nodeId, null, LIFECYCLE_PAGE),
      getRecallEligibility(b, nodeId),
    ]);
    setLifecycleLoading(false);
    if (!historyResult.ok) {
      setLifecycle([]);
      setLifecycleError(describe(historyResult));
    } else {
      setLifecycle(lifecycleHistoryOf(historyResult).rows);
    }
    if (!recallResult.ok) {
      setRecall(null);
      setRecallError(describe(recallResult));
    } else {
      setRecall(recallEligibilityOf(recallResult));
    }
  }, [b, nodeId]);

  useEffect(() => {
    void refreshLifecycle();
  }, [refreshLifecycle]);

  return {
    trace: {
      id: traceId,
      setId: setTraceId,
      row: trace,
      loading: traceLoading,
      error: traceError,
      lookup: () => void lookupTrace(traceId.trim()),
    },
    hits: {
      rows: hits,
      hasMore: hitsNextAfter !== null,
      error: hitsError,
      loadMore: () => void loadMoreHits(),
    },
    sessionLinks: {
      rows: sessionLinks,
      loading: sessionLinksLoading,
      error: sessionLinksError,
      direction: linkDirection,
      setDirection: setLinkDirection,
      refresh: () => void refreshSessionLinks(),
    },
    lifecycle: {
      rows: lifecycle,
      loading: lifecycleLoading,
      error: lifecycleError,
    },
    recall: {
      value: recall,
      error: recallError,
    },
  };
}
