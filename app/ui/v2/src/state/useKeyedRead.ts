import { useCallback, useRef, useState } from "react";

/** What one read was issued FOR: the selection's key, the values that key was
 *  computed from, and its place among the reads this hook has started. */
export type ReadTicket<T> = { key: string | null; value: T; seq: number };

/** The ui-stale guard, keyed on the selection rather than counted (round 3).
 *
 * Round 2 guarded each read with a bare "latest call wins" counter. That is
 * wrong for a STALE CLOSURE: `send`/`join` in useMemory, `applyLifecycleWrite`
 * in useEvidenceReview and `refreshAll` in useListing all called a refresh
 * bound at an earlier render, so it carried the session / node / workspace of
 * THAT render. Send in sA, switch to sB mid-append: B's read goes out, then
 * the post-send read for sA bumps the counter and wins -- sA's transcript
 * under sB, every time.
 *
 * Here:
 *   - `now` is rewritten on EVERY render, so it moves in the same render as
 *     the selection. `begin()` reads the selection from it, never from the
 *     caller's closure: a post-write refresh always reads what is on screen.
 *   - a result lands only while its key is still `now`'s key (`live`). A read
 *     for a session, node or workspace already left is dropped, whatever
 *     order the responses arrive in.
 *   - among reads for the SAME key, the newest wins (`seq`). Two reads for
 *     one key are a real case -- the select-time read and a post-send read,
 *     or a fast next/prev page -- and the older must not erase the newer.
 *     Because `begin()` only ever issues for the current key, "newest" can no
 *     longer be a read for somewhere already left.
 *   - `loading` is derived: true only while the CURRENT key has a read
 *     pending. A deselect or scope change moves the key, so a dropped read
 *     can no longer latch the flag on (the round-1 latch).
 *   - the pending marker records WHICH read set it (its `seq`), and that read
 *     clears it when it finishes, whether or not its result is used. Clearing
 *     only on a live landing latched the flag the other way (wave-8 verifier):
 *     ask in sA, switch to sB, sA's answer is dropped, back on sA -> `loading`
 *     read true forever with nothing in flight. */
export function useKeyedRead<T>(value: T, keyOf: (v: T) => string | null) {
  const key = keyOf(value);
  const now = useRef({ key, value });
  now.current = { key, value };
  const seq = useRef(0);
  const [pending, setPending] = useState<{ key: string | null; seq: number } | null>(null);

  /** Start a read for whatever is selected NOW. */
  const begin = useCallback((): ReadTicket<T> => {
    const ticket = { ...now.current, seq: ++seq.current };
    setPending({ key: ticket.key, seq: ticket.seq });
    return ticket;
  }, []);

  /** The current read's ticket WITHOUT starting a new one -- for a "load
   *  more" that appends to the page on screen rather than replacing it. */
  const peek = useCallback((): ReadTicket<T> => ({ ...now.current, seq: seq.current }), []);

  /** Is this still the read for what is on screen? */
  const live = useCallback(
    (t: ReadTicket<T>) => t.key === now.current.key && t.seq === seq.current,
    [],
  );

  /** The read is finished: if it is the one that set the pending marker, the
   *  marker goes (used or dropped). Returns `live` -- whether to use it. */
  const land = useCallback(
    (t: ReadTicket<T>) => {
      setPending((p) => (p !== null && p.seq === t.seq ? null : p));
      return live(t);
    },
    [live],
  );

  return { key, now, begin, peek, live, land, loading: key !== null && pending !== null && pending.key === key };
}
