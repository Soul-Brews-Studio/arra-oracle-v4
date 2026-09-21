/** Fetching for the EXPLORE page: peers, sessions and nodes, each a
 *  keyset-paginated list walked one page at a time.
 *
 * Same discipline as `useMemory`/`useKnowledge`: components stay
 * presentational, every request lives here. What's specific to this hook is
 * the cursor bookkeeping a keyset API forces on the caller -- there is no
 * page number to ask for, only "give me rows after THIS cursor". That makes
 * `next()` easy (the server hands you the next cursor) and `prev()` a bit of
 * bookkeeping: it is NOT "cursor minus one", it is "the cursor I already used
 * one page ago", which only exists if I remembered it. `history` is that
 * memory -- the `after` value used for every page visited so far, in the
 * order visited. `prev()` walks back through it; it can never walk further
 * back than page 0, because there is nothing before "no cursor" to remember.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Bank } from "../api/memory";
import { type Page, type PeerRow, type SessionRow, type NodeRow, listPeers, listSessions, listNodes } from "../api/listing";

const PAGE_SIZE = 50;

type ListState<T> = {
  rows: T[];
  total: string | null;
  supported: boolean;
  loading: boolean;
  error: string | null;
  pageIndex: number; // pages WALKED so far, 0-based -- never a claim about total pages
  hasNext: boolean;
  hasPrev: boolean;
};

/** One cursor-paginated list, generic over the row type. `fetchPage` is the
 *  only thing that differs between peers/sessions/nodes -- everything else
 *  (history, loading, error) is identical bookkeeping, so it lives here once
 *  instead of three times. */
function useCursorList<T>(fetchPage: (after: string | null, includeTotal: boolean) => Promise<Page<T>>) {
  const history = useRef<Array<string | null>>([null]);
  // Mirrors `state.pageIndex`/`nextCursor` in a ref so next()/prev() always
  // read the latest value without depending on `state` -- putting `state` in
  // a `useCallback` dep array here would rebuild these on every fetch, which
  // is the kind of churn `useMemory` avoids by keeping fetch identity stable.
  const cursor = useRef({ pageIndex: 0, nextCursor: null as string | null });
  const [state, setState] = useState<ListState<T>>({
    rows: [],
    total: null,
    supported: true,
    loading: false,
    error: null,
    pageIndex: 0,
    hasNext: false,
    hasPrev: false,
  });

  const load = useCallback(
    async (index: number, includeTotal: boolean) => {
      setState((s) => ({ ...s, loading: true, error: null }));
      const after = history.current[index] ?? null;
      const page = await fetchPage(after, includeTotal);
      cursor.current = { pageIndex: index, nextCursor: page.nextCursor };
      setState((s) => ({
        rows: page.rows,
        total: includeTotal ? page.total : s.total,
        supported: page.supported,
        loading: false,
        error: page.supported ? null : "this server does not have listing endpoints yet",
        pageIndex: index,
        hasNext: page.nextCursor !== null,
        hasPrev: index > 0,
      }));
    },
    [fetchPage],
  );

  const refresh = useCallback(() => {
    history.current = [null];
    void load(0, true);
  }, [load]);

  const next = useCallback(() => {
    const { nextCursor, pageIndex } = cursor.current;
    if (nextCursor === null) return;
    const idx = pageIndex + 1;
    // A fresh entry, not a rewrite: history is append-only so prev() always
    // has something to walk back to, even if next() is called repeatedly.
    history.current[idx] = nextCursor;
    void load(idx, false);
  }, [load]);

  const prev = useCallback(() => {
    const { pageIndex } = cursor.current;
    if (pageIndex === 0) return;
    void load(pageIndex - 1, false);
  }, [load]);

  return { state, refresh, next, prev, load };
}

export function useListing(b: Bank) {
  const scope = useMemo(() => `${b.bank}:${b.workspace}`, [b.bank, b.workspace]);
  const [typeTerm, setTypeTerm] = useState<string | null>(null);

  const peers = useCursorList<PeerRow>(
    useCallback((after, includeTotal) => listPeers(b, after, PAGE_SIZE, includeTotal), [b]),
  );
  const sessions = useCursorList<SessionRow>(
    useCallback((after, includeTotal) => listSessions(b, after, PAGE_SIZE, includeTotal), [b]),
  );
  const nodes = useCursorList<NodeRow>(
    useCallback(
      (after, includeTotal) => listNodes(b, after, PAGE_SIZE, includeTotal, typeTerm),
      [b, typeTerm],
    ),
  );

  const refreshAll = useCallback(() => {
    peers.refresh();
    sessions.refresh();
    nodes.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every list restarts at page 0 when the bank/workspace changes -- a
  // cursor minted against one workspace means nothing in another, the same
  // trap `useMemory`'s roster reset avoids for peers and sessions.
  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  return { peers, sessions, nodes, typeTerm, setTypeTerm, refreshAll };
}
