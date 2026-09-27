/** Server state for the knowledge search box (#30/#33): keyword and semantic
 *  retrieval, kept in one hook so the component stays presentational, same
 *  discipline as `useKnowledge`/`useMemory`.
 *
 * Debounced by a plain timer plus a request-id guard (not an AbortController
 * -- this POC's other hooks don't use one either, and a stale response here
 * only means "briefly render last query's hits", never a wrong write): a
 * keystroke a user is still typing should not fire a request per character,
 * and a reply for a since-abandoned query must never overwrite a later one's
 * result.
 *
 * The five response-shaped fields (errorCode/keywordHits/semanticHits/
 * scanReason/embeddingProfile) live in ONE `SearchOutcome` object, not five
 * separate `useState`s, and are only ever replaced via `applySearchOutcome`
 * inside a functional `setOutcome` update. Fix-round finding: `run` is
 * memoized on `[bank]` only, so reading those state variables directly out
 * of the closure (as this used to) captured whatever they were bound to at
 * mount, not the latest value -- a functional update sidesteps that
 * regardless of `run`'s own dependency list.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type Bank } from "../api/memory";
import { searchKnowledgeKeyword, searchKnowledgeSemantic } from "../api/search";
import { applySearchOutcome, type SearchOutcome } from "./applySearchOutcome";
import { searchOutcomeView } from "./searchOutcomeView";

export type SearchMode = "keyword" | "semantic";

const DEBOUNCE_MS = 300;

const EMPTY_OUTCOME: SearchOutcome = {
  mode: "keyword",
  errorCode: null,
  keywordHits: [],
  semanticHits: [],
  scanReason: null,
  embeddingProfile: null,
};

/** `routed` restores `query`/`mode` from the route on mount -- fix-round
 *  finding #2 (PR #110 follow-up): ExploreView remounts on the round trip to
 *  the node view and back, which used to reset this hook's `useState` and
 *  drop whatever was typed. The caller reads it from the route
 *  (`searchRouteState`) and is responsible for writing it back out
 *  (`searchRoutePatch` + `route.replace` on every `query`/`mode` change) --
 *  this hook stays route-agnostic, same as `useMemory`'s `peer`/`session`
 *  contract with `App.tsx`.
 *
 * `routed` is read on EVERY render, not just at mount (round-3 blocking
 * finding): a browser Back/Forward between two explore history entries
 * (e.g. `tab=nodes` <-> `tab=search&q=...`) changes the route while
 * `ExploreView` stays mounted -- a different `view` never happens, so the
 * mount-only `useState` initializer this used to be never saw the new
 * value, and the box and the URL drifted apart. The effect below applies
 * `routed` to local state whenever it differs from the last `routed` value
 * this hook itself has seen -- but `lastRouted` is updated unconditionally,
 * including when local edits (typing) round-trip back through the route via
 * the caller's `onSearchChange`, so that echo is recognised as "already
 * applied" and does not bounce back into another `setQuery`/`setMode` --
 * the update loop the caller has to avoid. */
export function useKnowledgeSearch(bank: Bank, routed: { query: string; mode: SearchMode }) {
  const [query, setQuery] = useState(routed.query);
  const [mode, setMode] = useState<SearchMode>(routed.mode);
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<SearchOutcome>(EMPTY_OUTCOME);

  const requestId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRouted = useRef(routed);

  useEffect(() => {
    if (routed.query !== lastRouted.current.query || routed.mode !== lastRouted.current.mode) {
      setQuery(routed.query);
      setMode(routed.mode);
    }
    lastRouted.current = routed;
  }, [routed.query, routed.mode]);

  const run = useCallback(
    async (q: string, m: SearchMode) => {
      const id = ++requestId.current;
      if (q.trim() === "") {
        setLoading(false);
        setOutcome(EMPTY_OUTCOME);
        return;
      }
      setLoading(true);
      setOutcome((prev) => ({ ...prev, errorCode: null }));
      const result = m === "keyword" ? await searchKnowledgeKeyword(bank, q) : await searchKnowledgeSemantic(bank, q);
      if (id !== requestId.current) return; // a newer query has already started
      setLoading(false);
      // `applySearchOutcome` is the single, unit-tested place that decides
      // the next state from one response -- see its own comment for the
      // fix-round bug (a keyword scanReason surviving into semantic hits)
      // this replaced the inline branches with.
      setOutcome((prev) => applySearchOutcome(m, result, prev));
    },
    [bank],
  );

  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(query, mode), DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode, bank.bank, bank.workspace, bank.token]);

  // What to show for the CURRENTLY ACTIVE mode, decided by the pure,
  // unit-tested `searchOutcomeView` -- see its comment for the fix-round bug
  // (a stale scan note surviving a mode switch through the debounce window)
  // this replaced the inline `mode === "keyword" ? ... : ...` ternary with.
  //
  // Round-3 finding: this used to list `view`'s fields out one at a time
  // (`errorCode: view.errorCode`, ...), which is exactly the shape a typo'd
  // revert to `outcome.errorCode`/`outcome.scanReason` hides inside --
  // nothing pinned that this hook actually reads the GATED view rather than
  // the raw outcome. Spreading `...view` instead makes that revert a type
  // error (`outcome` has `keywordHits`/`semanticHits`, not `hits` -- callers
  // destructuring `search.hits` would break), not just a silent regression.
  const view = searchOutcomeView(outcome, mode);

  return {
    query,
    setQuery,
    mode,
    setMode,
    loading,
    ...view,
  };
}
