/** Server state for the #33 "evidence review" surface: traces, session links,
 *  node lifecycle, and (fix-round R12) direct/reverse revision evidence plus
 *  the two lifecycle writes. Sibling of `useKnowledge`/`useMemory` -- same
 *  discipline, every request in this lane issued here, components stay
 *  presentational.
 *
 * FIVE independent lanes, refetched on different triggers, because the
 * kernels are scoped by different identifiers (see `api/evidenceReview.ts`'s
 * header for why there is no single "evidence for X"):
 *   - traces are looked up MANUALLY, by an id the caller must already hold
 *     (no `listTraces` exists yet -- a search/list surface is explicitly
 *     out of this slice's scope, per this issue's brief).
 *   - session links refetch whenever the selected SESSION changes.
 *   - lifecycle history and recall eligibility refetch whenever the
 *     selected NODE changes.
 *   - direct evidence (association) refetches whenever the selected NODE
 *     changes, always against its captured head (`revision_id: null`).
 *   - reverse evidence (dependents) refetches right after direct evidence
 *     resolves, targeting that SAME exact `(node_id, revision_id)` -- "what
 *     this revision cites" and "who cites this revision" are the same
 *     identity seen from two directions, so one fetch chains into the other
 *     instead of the caller supplying a revision id twice.
 *
 * Fix-round hardening (all four were nonblocking findings on the previous
 * pass, addressed here):
 *   1. every async lane guards against a STALE response landing after the
 *      selection has already moved on -- since ui-stale round 3 a KEYED
 *      guard per lane (`useKeyedRead`): a result lands only while the
 *      node / session / scope it was issued for is still the one on screen,
 *      and every refresh -- including the one after a lifecycle write --
 *      reads that selection at call time, never from a stale closure.
 *   2. `hitsNextAfter` is reset on every trace-lookup or hits-read failure,
 *      so "load more" can never send one trace's cursor against a different
 *      `trace_id`.
 *   3. session links page past their first 50 via `next_cursor`, with a
 *      `hasMore`/`loadMore` the panel can show instead of silently stopping.
 *   4. a looked-up trace (and its hits) resets when the bank/workspace scope
 *      changes, instead of surviving under a dataset it was never read from.
 */
import { useCallback, useEffect, useState } from "react";
import { type Bank } from "../api/memory";
import {
  type AssociationResult,
  type DependentOccurrence,
  type DependentsCursor,
  type LifecycleEventRow,
  type RecallEligibility,
  type SessionLinkRow,
  type TraceHitRow,
  type TraceRow,
  MAX_DEPENDENTS_PAGE,
  associationsOf,
  dependentsOf,
  getRecallEligibility,
  getRevisionAssociations,
  getTrace,
  hitsOf,
  lifecycleHistoryOf,
  listLifecycleHistory,
  listSessionLinks,
  listTraceHits,
  recallEligibilityOf,
  scanDependents,
  sessionLinksOf,
  traceOf,
} from "../api/evidenceReview";
import { describeResult as describe } from "./describeResult";
import { useKeyedRead } from "./useKeyedRead";
import { useLifecycleWrites } from "./useLifecycleWrites";
import { useEvidenceStatus } from "./useEvidenceStatus";

const HITS_PAGE = 50;
const LINKS_PAGE = 50;
const LIFECYCLE_PAGE = 50;

const k = (...parts: Array<string | null>) => JSON.stringify(parts);

/** What a node-scoped read is FOR: the node and every input that changes it. */
const nodeKey = (v: { b: Bank; nodeId: string | null }) =>
  v.nodeId === null ? null : k(v.b.bank, v.b.workspace, v.b.token, v.nodeId);

export function useEvidenceReview(
  b: Bank,
  nodeId: string | null,
  sessionName: string | null,
  peerName: string | null = null,
) {
  const scope = `${b.bank}:${b.workspace}`;

  // ---- traces: manual lookup by id ---------------------------------------
  const [traceId, setTraceId] = useState("");
  const [trace, setTrace] = useState<TraceRow | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [hits, setHits] = useState<TraceHitRow[]>([]);
  const [hitsNextAfter, setHitsNextAfter] = useState<string | null>(null);
  const [hitsError, setHitsError] = useState<string | null>(null);
  const traceRead = useKeyedRead(b, (v) => k(v.bank, v.workspace, v.token));

  // A trace is scoped to a dataset -- it must not survive a bank/workspace
  // switch just because no new lookup was made yet.
  useEffect(() => {
    // A lookup in flight for the old scope is dropped by its key, and its
    // loading flag with it (ui-stale).
    setTraceId("");
    setTrace(null);
    setTraceError(null);
    setHits([]);
    setHitsNextAfter(null);
    setHitsError(null);
  }, [scope]);

  const lookupTrace = useCallback(
    async (id: string) => {
      const t = traceRead.begin();
      const b = t.value;
      setTraceError(null);
      setHitsError(null);
      const traceResult = await getTrace(b, id);
      if (!traceRead.live(t)) return; // superseded by a newer lookup or a scope change
      if (!traceResult.ok) {
        traceRead.land(t);
        setTrace(null);
        setHits([]);
        setHitsNextAfter(null);
        setTraceError(describe(traceResult));
        return;
      }
      const found = traceOf(traceResult);
      setTrace(found);
      if (found === null) {
        // Not an error: `getTrace` answers `null` for an id it does not
        // have, same as `getAcceptedHead` for a node it does not have.
        traceRead.land(t);
        setHits([]);
        setHitsNextAfter(null);
        return;
      }
      const hitsResult = await listTraceHits(b, id, null, HITS_PAGE);
      if (!traceRead.land(t)) return;
      if (!hitsResult.ok) {
        setHits([]);
        setHitsNextAfter(null);
        setHitsError(describe(hitsResult));
        return;
      }
      const page = hitsOf(hitsResult);
      setHits(page.rows);
      setHitsNextAfter(page.nextAfterPosition);
    },
    [traceRead],
  );

  const loadMoreHits = useCallback(async () => {
    if (trace === null || hitsNextAfter === null) return;
    const t = traceRead.peek();
    const hitsResult = await listTraceHits(t.value, trace.id, hitsNextAfter, HITS_PAGE);
    if (!traceRead.live(t)) return;
    if (!hitsResult.ok) {
      setHitsError(describe(hitsResult));
      return;
    }
    const page = hitsOf(hitsResult);
    setHits((prev) => [...prev, ...page.rows]);
    setHitsNextAfter(page.nextAfterPosition);
  }, [traceRead, trace, hitsNextAfter]);

  // ---- session links: follow the selected session ------------------------
  const [linkDirection, setLinkDirection] = useState<"from" | "to">("from");
  const [sessionLinks, setSessionLinks] = useState<SessionLinkRow[]>([]);
  const [sessionLinksNextCursor, setSessionLinksNextCursor] = useState<string | null>(null);
  const [sessionLinksError, setSessionLinksError] = useState<string | null>(null);
  const linksRead = useKeyedRead({ b, sessionName, linkDirection }, (v) =>
    v.sessionName === null ? null : k(v.b.bank, v.b.workspace, v.b.token, v.sessionName, v.linkDirection),
  );

  const refreshSessionLinks = useCallback(async () => {
    const t = linksRead.begin();
    const { b, sessionName, linkDirection } = t.value;
    if (sessionName === null) {
      setSessionLinks([]);
      setSessionLinksNextCursor(null);
      setSessionLinksError(null);
      return;
    }
    setSessionLinksError(null);
    const result = await listSessionLinks(b, sessionName, linkDirection, null, LINKS_PAGE);
    if (!linksRead.land(t)) return;
    if (!result.ok) {
      setSessionLinks([]);
      setSessionLinksNextCursor(null);
      setSessionLinksError(describe(result));
      return;
    }
    const page = sessionLinksOf(result);
    setSessionLinks(page.rows);
    setSessionLinksNextCursor(page.nextCursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selection read from `linksRead`
  }, [b, sessionName, linkDirection]);

  useEffect(() => {
    void refreshSessionLinks();
  }, [refreshSessionLinks]);

  const loadMoreSessionLinks = useCallback(async () => {
    const t = linksRead.peek();
    const { b, sessionName, linkDirection } = t.value;
    if (sessionName === null || sessionLinksNextCursor === null) return;
    const result = await listSessionLinks(b, sessionName, linkDirection, sessionLinksNextCursor, LINKS_PAGE);
    if (!linksRead.live(t)) return;
    if (!result.ok) {
      setSessionLinksError(describe(result));
      return;
    }
    const page = sessionLinksOf(result);
    setSessionLinks((prev) => [...prev, ...page.rows]);
    setSessionLinksNextCursor(page.nextCursor);
  }, [linksRead, sessionLinksNextCursor]);

  // ---- lifecycle + recall eligibility: follow the selected node ----------
  const [lifecycle, setLifecycle] = useState<LifecycleEventRow[]>([]);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [recall, setRecall] = useState<RecallEligibility | null>(null);
  const [recallError, setRecallError] = useState<string | null>(null);
  const lifecycleRead = useKeyedRead({ b, nodeId }, nodeKey);

  const refreshLifecycle = useCallback(async () => {
    const t = lifecycleRead.begin();
    const { b, nodeId } = t.value;
    if (nodeId === null) {
      setLifecycle([]);
      setLifecycleError(null);
      setRecall(null);
      setRecallError(null);
      return;
    }
    setLifecycleError(null);
    setRecallError(null);
    const [historyResult, recallResult] = await Promise.all([
      listLifecycleHistory(b, nodeId, null, LIFECYCLE_PAGE),
      getRecallEligibility(b, nodeId),
    ]);
    // A response for a node the caller has already navigated AWAY from must
    // never land on the now-selected one -- switching nodes quickly must not
    // show node A's recall verdict under node B.
    if (!lifecycleRead.land(t)) return;
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
      const parsed = recallEligibilityOf(recallResult);
      setRecall(parsed);
      // A malformed-but-`ok` body used to read exactly like "no verdict yet",
      // silently hiding the badge with no error at all -- say so instead.
      setRecallError(parsed === null ? "malformed recall eligibility response" : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- node read from `lifecycleRead`
  }, [b, nodeId]);

  useEffect(() => {
    void refreshLifecycle();
  }, [refreshLifecycle]);

  // ---- direct evidence (association) + reverse evidence (dependents) -----
  // Both target the SAME resolved `(node_id, revision_id)` -- the captured
  // head, since this review surface has no per-revision picker (#33's brief
  // scopes evidence review to "for a node", and the diff view already covers
  // comparing two exact revisions).
  const [association, setAssociation] = useState<AssociationResult | null>(null);
  const [associationError, setAssociationError] = useState<string | null>(null);
  const [dependents, setDependents] = useState<DependentOccurrence[]>([]);
  const [dependentsNextCursor, setDependentsNextCursor] = useState<DependentsCursor | null>(null);
  // The key whose reverse read is in flight; `loading` only while it is the
  // key on screen, so a dropped chain cannot latch the flag.
  const [dependentsFor, setDependentsFor] = useState<string | null>(null);
  const [dependentsError, setDependentsError] = useState<string | null>(null);
  const associationRead = useKeyedRead({ b, nodeId }, nodeKey);

  const fetchDependentsPage = useCallback(
    async (b: Bank, target: { node_id: string; revision_id: string }, cursor: DependentsCursor | null) => {
      const result = await scanDependents(b, target, MAX_DEPENDENTS_PAGE, cursor);
      if (!result.ok) return { ok: false as const, error: describe(result) };
      const page = dependentsOf(result);
      if (page.outcome === "restart_required") {
        return { ok: false as const, error: "dataset changed mid-scan; restart required" };
      }
      if (page.outcome === "error") return { ok: false as const, error: "could not read dependents" };
      return { ok: true as const, occurrences: page.occurrences, nextCursor: page.nextCursor };
    },
    [],
  );

  const refreshAssociation = useCallback(async () => {
    const t = associationRead.begin();
    const { b, nodeId } = t.value;
    // Cleared here, not per branch: this read supersedes any reverse read
    // still in flight, and a path that never issues its own (no node, a
    // failed or empty association) would otherwise leave that read's flag on.
    setDependentsFor(null);
    if (nodeId === null) {
      setAssociation(null);
      setAssociationError(null);
      setDependents([]);
      setDependentsNextCursor(null);
      setDependentsError(null);
      return;
    }
    setAssociationError(null);
    const result = await getRevisionAssociations(b, nodeId, null);
    if (!associationRead.land(t)) return;
    if (!result.ok) {
      setAssociation(null);
      setAssociationError(describe(result));
      setDependents([]);
      setDependentsNextCursor(null);
      return;
    }
    const row = associationsOf(result);
    setAssociation(row);
    if (row === null) {
      setDependents([]);
      setDependentsNextCursor(null);
      setDependentsError(null);
      return;
    }
    setDependentsFor(t.key);
    setDependentsError(null);
    const page = await fetchDependentsPage(b, { node_id: row.node_id, revision_id: row.revision_id }, null);
    if (!associationRead.live(t)) return;
    setDependentsFor(null);
    if (!page.ok) {
      setDependents([]);
      setDependentsNextCursor(null);
      setDependentsError(page.error);
      return;
    }
    setDependents(page.occurrences);
    setDependentsNextCursor(page.nextCursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- node read from `associationRead`
  }, [b, nodeId, fetchDependentsPage]);

  useEffect(() => {
    void refreshAssociation();
  }, [refreshAssociation]);

  const loadMoreDependents = useCallback(async () => {
    if (association === null || dependentsNextCursor === null) return;
    const t = associationRead.peek();
    const page = await fetchDependentsPage(
      t.value.b,
      { node_id: association.node_id, revision_id: association.revision_id },
      dependentsNextCursor,
    );
    if (!associationRead.live(t)) return;
    if (!page.ok) {
      setDependentsError(page.error);
      return;
    }
    setDependents((prev) => [...prev, ...page.occurrences]);
    setDependentsNextCursor(page.nextCursor);
  }, [associationRead, association, dependentsNextCursor, fetchDependentsPage]);

  // ---- lifecycle writes: retire / supersede (#29, #33 R12) ----------------
  const lifecycleActions = useLifecycleWrites(b, nodeId, peerName, lifecycleRead.key, refreshLifecycle);

  // #33 AC3: live status behind the stale/unavailable evidence labels.
  const evidenceStatus = useEvidenceStatus(b, association, dependents);

  return {
    trace: {
      id: traceId,
      setId: setTraceId,
      row: trace,
      loading: traceRead.loading,
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
      loading: linksRead.loading,
      error: sessionLinksError,
      direction: linkDirection,
      setDirection: setLinkDirection,
      hasMore: sessionLinksNextCursor !== null,
      loadMore: () => void loadMoreSessionLinks(),
      refresh: () => void refreshSessionLinks(),
    },
    lifecycle: {
      rows: lifecycle,
      loading: lifecycleRead.loading,
      error: lifecycleError,
      actions: lifecycleActions,
    },
    recall: {
      value: recall,
      error: recallError,
    },
    association: {
      row: association,
      loading: associationRead.loading,
      error: associationError,
      citedStatus: evidenceStatus.cited,
    },
    dependents: {
      rows: dependents,
      loading: dependentsFor !== null && dependentsFor === associationRead.key,
      error: dependentsError,
      hasMore: dependentsNextCursor !== null,
      loadMore: () => void loadMoreDependents(),
      citingStatus: evidenceStatus.citing,
    },
  };
}
