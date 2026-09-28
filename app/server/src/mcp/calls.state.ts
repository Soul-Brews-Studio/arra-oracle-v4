// Data-only module state for the call-log audit sink: ONE identity, imported
// by both calls.logCall.ts (increments on a failed write) and
// calls.auditFailureCount.ts (reads it). Splitting the counter out of either
// function's own file is what keeps that identity single -- two files each
// declaring `let auditFailures = 0` would silently diverge.

/** Fixed sanitized counter for audit-write failures; never exception text. */
export const auditFailuresState = { count: 0 };
