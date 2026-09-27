import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiResult } from "../api/client";
import { type LifecycleWriteOutcome, lifecycleWriteOutcomeOf, retireNode, supersedeNode } from "../api/evidenceReview";
import { type Bank } from "../api/memory";
import { describeResult as describe } from "./describeResult";

/** Retire / supersede for the node on screen (#29, #33 R12), split out of
 *  `useEvidenceReview` (ui-stale round 3) so both files stay under 500 lines.
 *
 * `nodeKey` is the SAME key `useEvidenceReview`'s lifecycle lane reads with,
 * so a write can tell whether the node it was issued for is still the one on
 * screen when it lands. `refreshLifecycle` reads the node on screen itself --
 * round 2 called a copy bound at click time, which re-read node A under B. */
export function useLifecycleWrites(
  b: Bank,
  nodeId: string | null,
  peerName: string | null,
  nodeKey: string | null,
  refreshLifecycle: () => Promise<void>,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<LifecycleWriteOutcome | null>(null);
  const onScreen = useRef(nodeKey);
  onScreen.current = nodeKey;

  // Fix-round 2 finding: node A's retire/supersede outcome must not linger
  // under node B (`DetailTabs` also remounts `LifecycleActions` per node, so
  // a half-filled form cannot be confirmed against the next node either).
  useEffect(() => {
    setOutcome(null);
    setError(null);
  }, [nodeKey]);

  const apply = useCallback(
    async (issuedFor: string | null, result: ApiResult) => {
      setBusy(false);
      // Refresh whatever is on screen either way: the write happened.
      if (issuedFor === onScreen.current) {
        const parsed = result.ok ? lifecycleWriteOutcomeOf(result) : null;
        if (!result.ok) setError(describe(result));
        else if (parsed === null) setError("malformed lifecycle write response");
        else {
          setOutcome(parsed);
          setError(parsed.outcome === "conflict" ? `conflict: ${parsed.reason}` : null);
        }
      }
      await refreshLifecycle();
    },
    [refreshLifecycle],
  );

  const start = () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    return onScreen.current;
  };

  const retire = useCallback(
    async (expectedRevisionId: string, reason: string) => {
      if (nodeId === null) return;
      const issuedFor = start();
      const result = await retireNode(b, { node_id: nodeId, expected_revision_id: expectedRevisionId, reason, peer_name: peerName });
      await apply(issuedFor, result);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [b, nodeId, peerName, apply],
  );

  const supersede = useCallback(
    async (expectedRevisionId: string, newNodeId: string, newRevisionId: string, reason: string) => {
      if (nodeId === null) return;
      const issuedFor = start();
      const result = await supersedeNode(b, {
        node_id: nodeId,
        expected_revision_id: expectedRevisionId,
        new_node_id: newNodeId,
        new_revision_id: newRevisionId,
        reason,
        peer_name: peerName,
      });
      await apply(issuedFor, result);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [b, nodeId, peerName, apply],
  );

  return {
    busy,
    error,
    outcome,
    retire: (expectedRevisionId: string, reason: string) => void retire(expectedRevisionId, reason),
    supersede: (expectedRevisionId: string, newNodeId: string, newRevisionId: string, reason: string) =>
      void supersede(expectedRevisionId, newNodeId, newRevisionId, reason),
  };
}
