const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key)/i;
const ASSIGNED_SECRET = /\b(authorization|api[-_]?key|token|password|secret)\s*[:=]\s*(?:Bearer\s+)?[^\s,;"']+/gi;
const BEARER_SECRET = /\bBearer\s+[^\s,;"']+/gi;

// Exported for `../audit/instanceAudit.appendInstanceAuditRow.ts` (#31
// maint-audit): the instance-level audit sink applies the SAME redaction
// rules (R5) rather than re-deriving the secret-key/pattern lists, which
// would drift.
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return value
      .replace(ASSIGNED_SECRET, "$1=[REDACTED]")
      .replace(BEARER_SECRET, "Bearer [REDACTED]");
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, seen)]),
  );
}
