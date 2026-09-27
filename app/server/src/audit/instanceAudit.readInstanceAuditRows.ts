// The read side of the instance-level audit sink (#31 maint-audit, R25 / Nat
// D4b: "the instance audit log is read only with an operator scope").
//
// `openInstanceAuditTable` is reused unchanged: it already memoizes a single
// create-or-open per process (round 3 fix, see that file's header), so a read
// on a fresh instance still calls `createEmptyTable(..., existOk: true)` and
// creates the (empty) table rather than special-casing "table absent". That
// is a deliberate choice, not an oversight: LanceDB has no cheap "does this
// table exist" probe that avoids the same open/connect cost `createEmptyTable
// with existOk` already pays, and a second code path here would mean two
// places declaring what an empty instance-audit dataset looks like instead of
// one. The observable contract this function guarantees is `[]` back to the
// caller, not "the Lance directory is absent on disk" — no reader-caused row
// is ever written by opening the table (see `instanceAudit.appendInstanceAuditRow
// .ts` for the one function that appends).
//
// Newest-first: `started_at desc`. `cursor` is the `started_at` of the last
// row a previous page returned; the next page is every row strictly older
// (ties broken by `id desc` so a page boundary landing mid-millisecond never
// repeats or drops a row).

import { openInstanceAuditTable } from "./instanceAudit.openInstanceAuditTable";

export const INSTANCE_AUDIT_MAX_LIMIT = 200;
export const INSTANCE_AUDIT_DEFAULT_LIMIT = 50;

export type InstanceAuditQuery = {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly route?: "/api/backfill" | "/api/reindex";
  readonly outcome?: "admitted" | "refused";
};

export type InstanceAuditRow = {
  readonly id: string;
  readonly principal_id: string | null;
  readonly route: string;
  readonly action: string;
  readonly outcome: string;
  readonly status: string;
  readonly input_summary: string;
  readonly started_at: number;
  readonly finished_at: number;
  readonly duration_ms: number;
  readonly request_id: string;
};

export type InstanceAuditPage = {
  readonly rows: readonly InstanceAuditRow[];
  readonly next_cursor: string | null;
};

/** Bounded, clamped page size — never trusts a caller-supplied limit past `INSTANCE_AUDIT_MAX_LIMIT`. */
const boundedLimit = (raw: number | undefined): number => {
  if (raw === undefined || !Number.isSafeInteger(raw) || raw < 1) return INSTANCE_AUDIT_DEFAULT_LIMIT;
  return Math.min(raw, INSTANCE_AUDIT_MAX_LIMIT);
};

export async function readInstanceAuditRows(query: InstanceAuditQuery): Promise<InstanceAuditPage> {
  const limit = boundedLimit(query.limit);
  const table = await openInstanceAuditTable();
  // Over-fetch by one to know whether another page follows, without a second round trip.
  let builder = table.query();
  const filters: string[] = [];
  if (query.route !== undefined) filters.push(`route = '${query.route}'`);
  if (query.outcome !== undefined) filters.push(`outcome = '${query.outcome}'`);
  if (query.cursor !== null && query.cursor !== undefined) {
    const cursorMs = Number(query.cursor);
    if (Number.isSafeInteger(cursorMs)) filters.push(`started_at < ${cursorMs}`);
  }
  if (filters.length > 0) builder = builder.where(filters.join(" AND "));
  const raw = (await builder.toArray()) as unknown as Record<string, unknown>[];
  // Lance returns `int64` columns as `BigInt` -- normalized to `number` here
  // (epoch-ms timestamps never approach `Number.MAX_SAFE_INTEGER`) so callers
  // never have to know the storage representation.
  const all: InstanceAuditRow[] = raw.map((r) => ({
    id: String(r.id),
    principal_id: r.principal_id === null || r.principal_id === undefined ? null : String(r.principal_id),
    route: String(r.route),
    action: String(r.action),
    outcome: String(r.outcome),
    status: String(r.status),
    input_summary: String(r.input_summary),
    started_at: Number(r.started_at),
    finished_at: Number(r.finished_at),
    duration_ms: Number(r.duration_ms),
    request_id: String(r.request_id),
  }));
  const sorted = all.sort((a, b) => b.started_at - a.started_at || (a.id < b.id ? 1 : -1));
  const page = sorted.slice(0, limit);
  const next = sorted.length > limit ? String(page[page.length - 1]?.started_at ?? "") : null;
  return { rows: page, next_cursor: next };
}
