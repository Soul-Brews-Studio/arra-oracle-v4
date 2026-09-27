import { type Page } from "./listing";
import { type Count, type Sample, SAMPLE_LIMIT } from "./overview";

type Fetch<T> = (limit: number, includeTotal: boolean) => Promise<Page<T>>;

/** One timed probe. `include_total` is always true, so on any 2xx the server
 *  answers with a decimal string; a null total therefore means the request did
 *  not succeed, which is what lets `failed` be told from a real zero without
 *  the HTTP status (`Page` deliberately drops it). That inference holds only
 *  while nothing filters the call -- filtered `listNodes` answers null by
 *  design, so route those through `countByType` instead.
 *
 * `terminal` hangs off the COUNT, not off the cursor. A failed request also
 * decodes to `nextCursor: null`, so reading the cursor alone answered "that
 * was the whole set" for a 401 and the sessions card printed "0 of — active"
 * under its own em dash. A page nobody received bounds nothing. */
export async function countWithSample<T>(
  method: string, fetch: Fetch<T>, limit = SAMPLE_LIMIT,
): Promise<Sample<T>> {
  const started = performance.now();
  const page = await fetch(limit, true);
  const durationMs = Math.round(performance.now() - started);
  if (!page.supported) {
    const note = `${method} is not on this server`;
    return { count: { method, total: null, outcome: "absent", note, durationMs }, rows: [], terminal: false };
  }
  if (page.total === null) {
    const note = `${method} did not answer with a count`;
    return { count: { method, total: null, outcome: "failed", note, durationMs }, rows: [], terminal: false };
  }
  const count: Count = { method, total: page.total, outcome: "counted", note: null, durationMs };
  return { count, rows: page.rows, terminal: page.nextCursor === null };
}
