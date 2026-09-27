import { useCallback, useEffect, useRef, useState } from "react";
import { getSearchFreshness } from "../api/getSearchFreshness";
import { listSearchChunks } from "../api/listSearchChunks";
import type { Bank } from "../api/memory";
import { describeResult } from "./describeResult";
import type { FreshnessRead } from "./searchFreshnessView";

/** The head revision's search freshness: `getSearchFreshness` for the active
 *  profile (and the workspace figures), then `listSearchChunks` for THIS
 *  revision under that profile. Refetched when the revision changes, and on
 *  `recheck()` -- indexing happens outside this view. A response for a
 *  revision already left is dropped (generation counter, the
 *  `useNodeLifecycle` pattern), so one node's freshness never lands on
 *  another. */
export function useSearchFreshness(b: Bank, revisionId: string | null) {
  const scope = `${b.bank}:${b.workspace}`;
  const [state, setState] = useState<{ key: string | null; read: FreshnessRead }>({
    key: null,
    read: { phase: "loading" },
  });
  const [tick, setTick] = useState(0);
  const gen = useRef(0);
  const key = revisionId === null ? null : `${scope}:${revisionId}`;

  useEffect(() => {
    const g = ++gen.current;
    if (revisionId === null) return;
    setState({ key, read: { phase: "loading" } });
    const land = (read: FreshnessRead) => {
      if (g === gen.current) setState({ key, read });
    };
    void (async () => {
      const f = await getSearchFreshness(b);
      if (!f.ok) return land({ phase: "error", stage: "freshness", message: describeResult(f) });
      const vectors = (f.body as { vectors?: { profile_id?: unknown } } | null)?.vectors;
      const profile = typeof vectors?.profile_id === "string" ? vectors.profile_id : null;
      // No profile to scope the chunk read by: the view reports the shape.
      if (profile === null) return land({ phase: "ok", freshness: f.body, chunks: null });
      const c = await listSearchChunks(b, revisionId, profile);
      if (!c.ok) return land({ phase: "error", stage: "chunks", message: describeResult(c) });
      land({ phase: "ok", freshness: f.body, chunks: c.body });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, b.token, revisionId, tick]);

  const recheck = useCallback(() => setTick((t) => t + 1), []);
  // Until the effect catches up with a new revision, this is "loading" for
  // THAT revision, not the previous revision's verdict.
  const read: FreshnessRead = state.key === key ? state.read : { phase: "loading" };
  return { read, recheck };
}
