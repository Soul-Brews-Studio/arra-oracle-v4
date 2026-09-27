// The observable write-failure counter for the instance-level audit sink
// (#31 maint-audit, Nat 2026-09-28 D4b). Its own file: fix-round 2's style
// finding split what was one file with two exports
// (`appendInstanceAuditRow.ts`) into two, one EXPORTED FUNCTION per file.
//
// `INSTANCE_AUDIT_FAILURE_STATE` is a plain mutable value, not a function
// (the one-function-per-file ratchet only counts exported functions), so
// `appendInstanceAuditRow.ts` can `state.count += 1` directly on write
// failure without a second exported function here.
//
// `appendInstanceAuditRow` increments this on any write failure rather than
// throwing back into the route (an audit outage must not take down
// maintenance) or swallowing the failure invisibly (D4b: a write failure
// must not silently succeed) — see that file's header for the full rationale
// and `transport-audit-instance.test.ts` for the forced-failure assertion.

export const INSTANCE_AUDIT_FAILURE_STATE = { count: 0 };

export function instanceAuditFailureCount(): number {
  return INSTANCE_AUDIT_FAILURE_STATE.count;
}
