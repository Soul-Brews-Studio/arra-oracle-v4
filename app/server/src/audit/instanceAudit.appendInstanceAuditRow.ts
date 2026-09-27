// The instance-level audit sink (#31 maint-audit, Nat 2026-09-28 D4b).
//
// `POST /api/backfill` and `POST /api/reindex` admit a GLOBAL action: no
// workspace, so no `mcp_calls` row (that table's `workspace_name` is NOT
// NULL, and a sentinel workspace was explicitly ruled out). This is the
// separate append-only sink: one row per admitted call AND per refused call,
// same redaction rules as the tenant audit (`mcp/calls.ts`'s `redact` /
// `truncate`, reused rather than re-derived — R5).
//
// A write failure must not silently succeed (D4b): it never throws back into
// the route (an audit outage must not take down maintenance), but it is
// never swallowed invisibly either — `instanceAuditFailureCount()` is a
// counter a caller/test can observe, exactly the pattern `mcp/calls.ts`
// already uses for the tenant log's own write failures.

import { truncate } from "../mcp/calls";
import { ensureInstanceAuditTable } from "./instanceAudit.openInstanceAuditTable";

export type InstanceAuditOutcome = "admitted" | "refused";

export interface InstanceAuditRecord {
  readonly principal_id: string | null;
  readonly route: "/api/backfill" | "/api/reindex";
  readonly action: "maintenance:backfill" | "maintenance:reindex";
  readonly outcome: InstanceAuditOutcome;
  readonly status: "ok" | "error";
  readonly input: unknown;
  readonly started_at: number;
  readonly finished_at: number;
  readonly request_id: string;
}

let failureCount = 0;

/** Observable, not exception-based (see file header): the write path a test
 *  can assert a failure against without racing a thrown error across an
 *  already-completed maintenance action. */
export function instanceAuditFailureCount(): number {
  return failureCount;
}

export async function appendInstanceAuditRow(record: InstanceAuditRecord): Promise<void> {
  const row = {
    id: `ia_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    principal_id: record.principal_id,
    route: record.route,
    action: record.action,
    outcome: record.outcome,
    status: record.status,
    input_summary: truncate(record.input),
    started_at: record.started_at,
    finished_at: record.finished_at,
    duration_ms: record.finished_at - record.started_at,
    request_id: record.request_id,
  };
  try {
    const { table, wroteSample } = await ensureInstanceAuditTable(row);
    if (!wroteSample) await table.add([row]);
  } catch {
    // Fixed sanitized counter, never exception text (mirrors
    // `mcp/calls.ts auditFailures`): the failure is observable, but the
    // maintenance action this audits is not aborted by an audit outage.
    failureCount += 1;
  }
}
