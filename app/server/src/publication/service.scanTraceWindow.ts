import { failPublication } from "./errors";
import { TRACES } from "./service.constants";
import { type DatasetAdapter } from "./service.types";

/**
 * Widened scan window for one `listTraces` page, mirroring `listNodes`'
 * `MAX_SCANNED_NODES`: matches can be sparse across the `created_at`-ordered
 * keyset, so the number of MATCHES requested (`limit`) cannot also bound how
 * many stored rows get examined to find them. One call's worth of extra read
 * work, never unbounded.
 */
export const MAX_SCANNED_TRACES = 1000;

export type TraceCandidate = { id: string; created_at: bigint; query: string };

const COLUMNS = ["id", "created_at", "query"];

const millisOf = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return failPublication("integrity_failure", "");
};

/** The kernel's ordering contract, `(created_at desc, id asc)`. */
const newestFirst = (a: TraceCandidate, b: TraceCandidate): number => {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

function candidatesOf(scanned: Record<string, unknown>[]): TraceCandidate[] {
  const seen = new Set<string>();
  const candidates: TraceCandidate[] = [];
  for (const row of scanned) {
    const id = row.id;
    if (typeof id !== "string") failPublication("integrity_failure", "");
    // A duplicate id in one window would be invisible to the compound sort;
    // caught here rather than let it silently double- or under-count.
    if (seen.has(id)) failPublication("integrity_failure", "");
    seen.add(id);
    const query = row.query;
    if (typeof query !== "string") failPublication("integrity_failure", "");
    candidates.push({ id, created_at: millisOf(row.created_at), query });
  }
  return candidates.sort(newestFirst);
}

/**
 * One `listTraces` scan window, sorted `(created_at desc, id asc)` and CUT
 * so that it is complete for every candidate it keeps: no stored row that
 * matches `predicate` and sorts before the window's last kept candidate is
 * ever missing from it. That is what makes "resume after the last examined
 * candidate" a complete keyset walk.
 *
 * `DatasetAdapter.orderedProjection` orders by ONE column, and a `LIMIT` on
 * `created_at desc` alone lets the storage engine pick WHICH rows of a tie
 * group at the window's tail make it in. Every millisecond above the tail is
 * whole (a row there would outrank the tail row, so it cannot have been cut),
 * but the tail millisecond may be partial. So a full window is cut at a tie
 * boundary:
 *
 * - the tail spans part of the window: drop the tail millisecond entirely.
 *   What is left is non-empty and whole, and the next page's predicate
 *   (`created_at < X OR (created_at = X AND id > Y)`, X above the tail)
 *   still reaches every tail row.
 * - the WHOLE window is one millisecond (a tie group of at least
 *   `MAX_SCANNED_TRACES` rows): dropping it would leave nothing, so that
 *   millisecond is re-read ordered by `id` instead. Those are exactly its
 *   smallest ids past the cursor -- a whole prefix in the kernel's own
 *   order -- and the cursor then moves through the group by `id`.
 *
 * `full` is whether the first read filled the window, i.e. whether rows may
 * remain past what was kept.
 */
export async function scanTraceWindow(
  reader: DatasetAdapter,
  predicate: string,
): Promise<{ candidates: TraceCandidate[]; full: boolean }> {
  const scanned = await reader.orderedProjection(
    TRACES,
    predicate,
    COLUMNS,
    { column: "created_at", ascending: false },
    MAX_SCANNED_TRACES,
  );
  const candidates = candidatesOf(scanned);
  if (scanned.length < MAX_SCANNED_TRACES) return { candidates, full: false };

  const tail = candidates[candidates.length - 1]!.created_at;
  if (candidates[0]!.created_at !== tail) {
    return { candidates: candidates.filter((c) => c.created_at !== tail), full: true };
  }

  const group = candidatesOf(
    await reader.orderedProjection(
      TRACES,
      `${predicate} AND created_at = ${tail.toString(10)}`,
      COLUMNS,
      { column: "id", ascending: true },
      MAX_SCANNED_TRACES,
    ),
  );
  // Traces are append-only, so the millisecond that just filled a whole
  // window cannot come back empty or holding another millisecond's row.
  if (group.length === 0 || group.some((c) => c.created_at !== tail)) failPublication("integrity_failure", "");
  return { candidates: group, full: true };
}
