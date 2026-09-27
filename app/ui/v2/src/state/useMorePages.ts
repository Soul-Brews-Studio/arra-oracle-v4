import { useCallback, useRef, useState } from "react";

/** One "load more": the result it extends -- the selection key it was read
 *  for, what it was read FOR (`of`), which version of it (`gen`) -- and the
 *  cursor it was issued with. */
export type MoreTicket<O, C> = { key: string | null; of: O; cursor: C; gen: number };

/** Binds a "load more" to the result on screen (ui-reads2, r3 finding 3).
 *
 * The old load-more took `useKeyedRead.peek()`: the key on screen NOW and the
 * seq of whatever read was in flight NOW. Neither names the result being
 * extended, so the ticket aliased the next one:
 *   - trace hits: t1's page 2, issued while t2's lookup was in flight, shared
 *     t2's seq and was appended to t2 (rows ["t2-p1", "t1-p2"]).
 *   - session links: after a switch to sB, "load more" sent sA's cursor with
 *     sB's name, and appended the answer to sB.
 *
 * Here the result on screen is recorded with what it was read for and a
 * generation. `next()` issues only for that result, with ITS values and ITS
 * cursor, and only while its key is still the key on screen. A page lands
 * only while that same generation is still on screen: any replacement (a
 * new lookup, a refresh, a reset, another page) moves the generation and
 * drops it -- including a double-clicked duplicate of the same page. A
 * load-more never touches the read's pending marker, so it has no land(). */
export function useMorePages<O, C>(now: { current: { key: string | null } }) {
  const shown = useRef<{ key: string | null; of: O | null; cursor: C | null; gen: number }>({
    key: null,
    of: null,
    cursor: null,
    gen: 0,
  });
  const [cursor, setCursor] = useState<C | null>(null);

  /** A first page landed (or the result was cleared): this is what a
   *  load-more now extends. */
  const reset = useCallback((key: string | null, of: O | null, after: C | null) => {
    shown.current = { key, of, cursor: after, gen: shown.current.gen + 1 };
    setCursor(after);
  }, []);

  /** A ticket for the next page of the result on screen, or null if there is
   *  none -- or if the selection already moved off it. */
  const next = useCallback((): MoreTicket<O, C> | null => {
    const s = shown.current;
    if (s.of === null || s.cursor === null || s.key !== now.current.key) return null;
    return { key: s.key, of: s.of, cursor: s.cursor, gen: s.gen };
  }, [now]);

  /** Is the result this page extends still the one on screen? */
  const shows = useCallback(
    (m: MoreTicket<O, C>) => m.gen === shown.current.gen && m.key === now.current.key,
    [now],
  );

  /** The page landed: apply it only if `shows(m)`, and advance the cursor. */
  const extend = useCallback(
    (m: MoreTicket<O, C>, after: C | null) => {
      if (!shows(m)) return false;
      shown.current = { ...shown.current, cursor: after, gen: m.gen + 1 };
      setCursor(after);
      return true;
    },
    [shows],
  );

  return { cursor, reset, next, shows, extend };
}
