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
 *      selection has already moved on (a generation counter per lane,
 *      bumped at the start of each fetch; a result is applied only if its
 *      generation is still current).
 *   2. `hitsNextAfter` is reset on every trace-lookup or hits-read failure,
 *      so "load more" can never send one trace's cursor against a different
 *      `trace_id`.
 *   3. session links page past their first 50 via `next_cursor`, with a
 *      `hasMore`/`loadMore` the panel can show instead of silently stopping.
 *   4. a looked-up trace (and its hits) resets when the bank/workspace scope
 *      changes, instead of surviving under a dataset it was never read from.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiResult } from "../api/client";
import { type Bank } from "../api/memory";
import {
  type AssociationResult,
  type DependentOccurrence,
  type DependentsCursor,
  type LifecycleEventRow,
  type LifecycleWriteOutcome,
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
  lifecycleWriteOutcomeOf,
  listLifecycleHistory,
  listSessionLinks,
  listTraceHits,
  recallEligibilityOf,
  retireNode,
  scanDependents,
  sessionLinksOf,
  supersedeNode,
  traceOf,
} from "../api/evidenceReview";
import { describeResult as describe } from "./describeResult";
import { useEvidenceStatus } from "./useEvidenceStatus";

const HITS_PAGE = 50;
const LINKS_PAGE = 50;
const LIFECYCLE_PAGE = 50;

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
  const [traceLoading, setTraceLoading] = useState(false);
  const [hits, setHits] = useState<TraceHitRow[]>([]);
  const [hitsNextAfter, setHitsNextAfter] = useState<string | null>(null);
  const [hitsError, setHitsError] = useState<string | null>(null);
  const traceGen = useRef(0);

  // A trace is scoped to a dataset -- it must not survive a bank/workspace
  // switch just because no new lookup was made yet.
  useEffect(() => {
    traceGen.current += 1;
    setTraceId("");
    setTrace(null);
    setTraceError(null);
    setHits([]);
    setHitsNextAfter(null);
    setHitsError(null);
  }, [scope]);

  const lookupTrace = useCallback(
    async (id: string) => {
      const gen = ++traceGen.current;
      setTraceLoading(true);
      setTraceError(null);
      setHitsError(null);
      const traceResult = await getTrace(b, id);
      if (gen !== traceGen.current) return; // superseded by a newer lookup or a scope change
      if (!traceResult.ok) {
        setTraceLoading(false);
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
        setTraceLoading(false);
        setHits([]);
        setHitsNextAfter(null);
        return;
      }
      const hitsResult = await listTraceHits(b, id, null, HITS_PAGE);
      if (gen !== traceGen.current) return;
      setTraceLoading(false);
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
    [b],
  );

  const loadMoreHits = useCallback(async () => {
    if (trace === null || hitsNextAfter === null) return;
    const gen = traceGen.current;
    const hitsResult = await listTraceHits(b, trace.id, hitsNextAfter, HITS_PAGE);
    if (gen !== traceGen.current) return;
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
  const [sessionLinksNextCursor, setSessionLinksNextCursor] = useState<string | null>(null);
  const [sessionLinksLoading, setSessionLinksLoading] = useState(false);
  const [sessionLinksError, setSessionLinksError] = useState<string | null>(null);
  const sessionLinksGen = useRef(0);

  const refreshSessionLinks = useCallback(async () => {
    const gen = ++sessionLinksGen.current;
    if (sessionName === null) {
      setSessionLinks([]);
      setSessionLinksNextCursor(null);
      setSessionLinksError(null);
      return;
    }
    setSessionLinksLoading(true);
    setSessionLinksError(null);
    const result = await listSessionLinks(b, sessionName, linkDirection, null, LINKS_PAGE);
    if (gen !== sessionLinksGen.current) return;
    setSessionLinksLoading(false);
    if (!result.ok) {
      setSessionLinks([]);
      setSessionLinksNextCursor(null);
      setSessionLinksError(describe(result));
      return;
    }
    const page = sessionLinksOf(result);
    setSessionLinks(page.rows);
    setSessionLinksNextCursor(page.nextCursor);
  }, [b, sessionName, linkDirection]);

  useEffect(() => {
    void refreshSessionLinks();
  }, [refreshSessionLinks]);

  const loadMoreSessionLinks = useCallback(async () => {
    if (sessionName === null || sessionLinksNextCursor === null) return;
    const gen = sessionLinksGen.current;
    const result = await listSessionLinks(b, sessionName, linkDirection, sessionLinksNextCursor, LINKS_PAGE);
    if (gen !== sessionLinksGen.current) return;
    if (!result.ok) {
      setSessionLinksError(describe(result));
      return;
    }
    const page = sessionLinksOf(result);
    setSessionLinks((prev) => [...prev, ...page.rows]);
    setSessionLinksNextCursor(page.nextCursor);
  }, [b, sessionName, linkDirection, sessionLinksNextCursor]);

  // ---- lifecycle + recall eligibility: follow the selected node ----------
  const [lifecycle, setLifecycle] = useState<LifecycleEventRow[]>([]);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [recall, setRecall] = useState<RecallEligibility | null>(null);
  const [recallError, setRecallError] = useState<string | null>(null);
  const lifecycleGen = useRef(0);

  const refreshLifecycle = useCallback(async () => {
    const gen = ++lifecycleGen.current;
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
    // A response for a node the caller has already navigated AWAY from must
    // never land on the now-selected one -- switching nodes quickly must not
    // show node A's recall verdict under node B.
    if (gen !== lifecycleGen.current) return;
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
      const parsed = recallEligibilityOf(recallResult);
      setRecall(parsed);
      // A malformed-but-`ok` body used to read exactly like "no verdict yet",
      // silently hiding the badge with no error at all -- say so instead.
      setRecallError(parsed === null ? "malformed recall eligibility response" : null);
    }
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
  const [associationLoading, setAssociationLoading] = useState(false);
  const [associationError, setAssociationError] = useState<string | null>(null);
  const [dependents, setDependents] = useState<DependentOccurrence[]>([]);
  const [dependentsNextCursor, setDependentsNextCursor] = useState<DependentsCursor | null>(null);
  const [dependentsLoading, setDependentsLoading] = useState(false);
  const [dependentsError, setDependentsError] = useState<string | null>(null);
  const associationGen = useRef(0);

  const fetchDependentsPage = useCallback(
    async (target: { node_id: string; revision_id: string }, cursor: DependentsCursor | null) => {
      const result = await scanDependents(b, target, MAX_DEPENDENTS_PAGE, cursor);
      if (!result.ok) return { ok: false as const, error: describe(result) };
      const page = dependentsOf(result);
      if (page.outcome === "restart_required") {
        return { ok: false as const, error: "dataset changed mid-scan; restart required" };
      }
      if (page.outcome === "error") return { ok: false as const, error: "could not read dependents" };
      return { ok: true as const, occurrences: page.occurrences, nextCursor: page.nextCursor };
    },
    [b],
  );

  const refreshAssociation = useCallback(async () => {
    const gen = ++associationGen.current;
    if (nodeId === null) {
      setAssociation(null);
      setAssociationError(null);
      setDependents([]);
      setDependentsNextCursor(null);
      setDependentsError(null);
      return;
    }
    setAssociationLoading(true);
    setAssociationError(null);
    const result = await getRevisionAssociations(b, nodeId, null);
    if (gen !== associationGen.current) return;
    setAssociationLoading(false);
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
    setDependentsLoading(true);
    setDependentsError(null);
    const page = await fetchDependentsPage({ node_id: row.node_id, revision_id: row.revision_id }, null);
    if (gen !== associationGen.current) return;
    setDependentsLoading(false);
    if (!page.ok) {
      setDependents([]);
      setDependentsNextCursor(null);
      setDependentsError(page.error);
      return;
    }
    setDependents(page.occurrences);
    setDependentsNextCursor(page.nextCursor);
  }, [b, nodeId, fetchDependentsPage]);

  useEffect(() => {
    void refreshAssociation();
  }, [refreshAssociation]);

  const loadMoreDependents = useCallback(async () => {
    if (association === null || dependentsNextCursor === null) return;
    const gen = associationGen.current;
    const page = await fetchDependentsPage(
      { node_id: association.node_id, revision_id: association.revision_id },
      dependentsNextCursor,
    );
    if (gen !== associationGen.current) return;
    if (!page.ok) {
      setDependentsError(page.error);
      return;
    }
    setDependents((prev) => [...prev, ...page.occurrences]);
    setDependentsNextCursor(page.nextCursor);
  }, [association, dependentsNextCursor, fetchDependentsPage]);

  // ---- lifecycle writes: retire / supersede (#29, #33 R12) ----------------
  const [lifecycleActionBusy, setLifecycleActionBusy] = useState(false);
  const [lifecycleActionError, setLifecycleActionError] = useState<string | null>(null);
  const [lifecycleActionOutcome, setLifecycleActionOutcome] = useState<LifecycleWriteOutcome | null>(null);

  // Fix-round 2 finding: node A's retire/supersede outcome must not linger
  // under node B (`DetailTabs` also remounts `LifecycleActions` per node, so
  // a half-filled form cannot be confirmed against the next node either).
  useEffect(() => {
    setLifecycleActionOutcome(null);
    setLifecycleActionError(null);
  }, [nodeId, scope]);

  const applyLifecycleWrite = useCallback(
    async (result: ApiResult) => {
      setLifecycleActionBusy(false);
      if (!result.ok) {
        setLifecycleActionError(describe(result));
        return;
      }
      const outcome = lifecycleWriteOutcomeOf(result);
      if (outcome === null) {
        setLifecycleActionError("malformed lifecycle write response");
        return;
      }
      setLifecycleActionOutcome(outcome);
      setLifecycleActionError(outcome.outcome === "conflict" ? `conflict: ${outcome.reason}` : null);
      await refreshLifecycle();
    },
    [refreshLifecycle],
  );

  const retire = useCallback(
    async (expectedRevisionId: string, reason: string) => {
      if (nodeId === null) return;
      setLifecycleActionBusy(true);
      setLifecycleActionError(null);
      setLifecycleActionOutcome(null);
      const result = await retireNode(b, {
        node_id: nodeId,
        expected_revision_id: expectedRevisionId,
        reason,
        peer_name: peerName,
      });
      await applyLifecycleWrite(result);
    },
    [b, nodeId, peerName, applyLifecycleWrite],
  );

  const supersede = useCallback(
    async (expectedRevisionId: string, newNodeId: string, newRevisionId: string, reason: string) => {
      if (nodeId === null) return;
      setLifecycleActionBusy(true);
      setLifecycleActionError(null);
      setLifecycleActionOutcome(null);
      const result = await supersedeNode(b, {
        node_id: nodeId,
        expected_revision_id: expectedRevisionId,
        new_node_id: newNodeId,
        new_revision_id: newRevisionId,
        reason,
        peer_name: peerName,
      });
      await applyLifecycleWrite(result);
    },
    [b, nodeId, peerName, applyLifecycleWrite],
  );

  // #33 AC3: live status behind the stale/unavailable evidence labels.
  const evidenceStatus = useEvidenceStatus(b, association, dependents);

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
      hasMore: sessionLinksNextCursor !== null,
      loadMore: () => void loadMoreSessionLinks(),
      refresh: () => void refreshSessionLinks(),
    },
    lifecycle: {
      rows: lifecycle,
      loading: lifecycleLoading,
      error: lifecycleError,
      actions: {
        busy: lifecycleActionBusy,
        error: lifecycleActionError,
        outcome: lifecycleActionOutcome,
        retire: (expectedRevisionId: string, reason: string) => void retire(expectedRevisionId, reason),
        supersede: (expectedRevisionId: string, newNodeId: string, newRevisionId: string, reason: string) =>
          void supersede(expectedRevisionId, newNodeId, newRevisionId, reason),
      },
    },
    recall: {
      value: recall,
      error: recallError,
    },
    association: {
      row: association,
      loading: associationLoading,
      error: associationError,
      citedStatus: evidenceStatus.cited,
    },
    dependents: {
      rows: dependents,
      loading: dependentsLoading,
      error: dependentsError,
      hasMore: dependentsNextCursor !== null,
      loadMore: () => void loadMoreDependents(),
      citingStatus: evidenceStatus.citing,
    },
  };
}
