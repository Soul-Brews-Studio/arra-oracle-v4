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
  coveragePartial: false,
};

/** `routed` restores `query`/`mode` from the route on mount -- fix-round
 *  finding #2 (PR #110 follow-up): ExploreView remounts on the round trip to
 *  the node view and back, which used to reset this hook's `useState` and
 *  drop whatever was typed. The caller reads it from the route
 *  (`searchRouteState`) and this hook writes it back via `onRouteChange`,
 *  same as `useMemory`'s `peer`/`session` contract with `App.tsx`.
 *
 * `routed` is read on EVERY render, not just at mount (round-3 blocking
 * finding): a browser Back/Forward between two explore history entries
 * (e.g. `tab=nodes` <-> `tab=search&q=...`) changes the route while
 * `ExploreView` stays mounted -- a different `view` never happens, so the
 * mount-only `useState` initializer this used to be never saw the new
 * value, and the box and the URL drifted apart. The effect below applies
 * `routed` to local state whenever it differs from the last `routed` value
 * this hook itself has seen.
 *
 * Round-3 verifier finding (blocking): an EARLIER version of this fix wrote
 * the route back out from a second `useEffect` in the caller, keyed on
 * `query`/`mode`. That effect cannot tell "the user just typed" from "this
 * render's `query` is still the PREVIOUS value because the sync effect
 * above hasn't landed yet" -- both effects fire in the same commit, off
 * stale closures, and each one's write undoes the other's, forever (proven
 * live: Forward between `tab=nodes` and `tab=search&q=...` never settled,
 * 63000+ renders/2s). The fix is to stop reacting to `query`/`mode` for the
 * write direction at all: `setQuery`/`setMode` below call `onRouteChange`
 * THEMSELVES, imperatively, at the exact moment a caller (the input's
 * `onChange`, the mode toggle's `onClick`) asks for a local edit. A route
 * update landing from Back/Forward only ever calls the RAW `setState`
 * setters inside the effect above, never the wrapped ones, so it can never
 * trigger a write-back -- there is no longer a second effect for the two
 * directions to race against. */
export function useKnowledgeSearch(
  bank: Bank,
  routed: { query: string; mode: SearchMode },
  onRouteChange: (query: string, mode: SearchMode) => void,
) {
  const [query, setQueryState] = useState(routed.query);
  const [mode, setModeState] = useState<SearchMode>(routed.mode);
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<SearchOutcome>(EMPTY_OUTCOME);

  const requestId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRouted = useRef(routed);
  // Mirrors `query`/`mode` outside of React's render cycle so the wrapped
  // setters below can read "the other" current value (e.g. `setQuery` needs
  // today's `mode` to call `onRouteChange(q, mode)`) without adding either
  // setter to the other's dependency list.
  const current = useRef({ query, mode });
  current.current = { query, mode };

  useEffect(() => {
    if (routed.query !== lastRouted.current.query || routed.mode !== lastRouted.current.mode) {
      setQueryState(routed.query);
      setModeState(routed.mode);
    }
    lastRouted.current = routed;
  }, [routed.query, routed.mode]);

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      onRouteChange(q, current.current.mode);
    },
    [onRouteChange],
  );

  const setMode = useCallback(
    (m: SearchMode) => {
      setModeState(m);
      onRouteChange(current.current.query, m);
    },
    [onRouteChange],
  );

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
