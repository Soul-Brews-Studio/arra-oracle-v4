import { useEffect, useRef, useState } from "react";
import { lifecycleHistoryOf, listLifecycleHistory } from "../api/evidenceReview";
import type { Bank } from "../api/memory";
import { describeResult } from "./describeResult";
import type { LifecycleRead } from "./lifecycleGate";

/** Supersede and retire are terminal, so a node has at most one event:
 *  the first page always holds it. */
const PAGE = 50;

/** The Knowledge view's lifecycle read: the same `listLifecycleHistory` the
 *  Evidence tab's Lifecycle panel uses, refetched when the node or its head
 *  changes. A stale response for a node already navigated away from is
 *  dropped (generation counter, the `useEvidenceReview` pattern). */
export function useNodeLifecycle(b: Bank, nodeId: string | null, refreshKey: string | null): LifecycleRead {
  const scope = `${b.bank}:${b.workspace}`;
  const [read, setRead] = useState<LifecycleRead>({ nodeId, loading: nodeId !== null, error: null, rows: [] });
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    if (nodeId === null) {
      setRead({ nodeId: null, loading: false, error: null, rows: [] });
      return;
    }
    setRead({ nodeId, loading: true, error: null, rows: [] });
    void listLifecycleHistory(b, nodeId, null, PAGE).then((result) => {
      if (g !== gen.current) return;
      setRead({
        nodeId,
        loading: false,
        error: result.ok ? null : describeResult(result),
        rows: lifecycleHistoryOf(result).rows,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, b.token, nodeId, refreshKey]);

  // Until the effect has caught up with a new node id, report "loading" for
  // THAT node rather than the previous node's verdict.
  return read.nodeId === nodeId ? read : { nodeId, loading: nodeId !== null, error: null, rows: [] };
}
