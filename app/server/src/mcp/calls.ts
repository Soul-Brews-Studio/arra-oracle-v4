// The call log (SPEC §6.3) — non-optional.
//
//   "An MCP server you cannot watch is one you are trusting on faith.
//    'The model said it saved that' is not evidence a row exists."
//
// Successes AND failures. A call that errored is the one you most want to read
// later — both of digger-node's refusal-message fixes were found by reading its
// own call log, not by a test.

import { openCallLogTable } from "./calls.openCallLogTable";
import { recordableName } from "./calls.recordableName";

/** Inputs are truncated AT WRITE TIME, not at read time — otherwise a 100 KB
 *  argument blob lives in the log forever and is only trimmed when someone
 *  happens to look. */
const MAX_FIELD = 2000;

const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key)/i;
const ASSIGNED_SECRET = /\b(authorization|api[-_]?key|token|password|secret)\s*[:=]\s*(?:Bearer\s+)?[^\s,;"']+/gi;
const BEARER_SECRET = /\bBearer\s+[^\s,;"']+/gi;

const safeInteger = (value: bigint) =>
  value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value.toString();

const wireInteger = (value: bigint | number) =>
  typeof value === "bigint"
    ? safeInteger(value)
    : Number.isSafeInteger(value) ? value : String(value);

const wireTime = (value: bigint | number) => {
  const exact = wireInteger(value);
  if (typeof exact === "string") return exact;
  const date = new Date(exact);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(exact);
};

const jsonSafe = (_key: string, value: unknown) => typeof value === "bigint" ? safeInteger(value) : value;

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
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

const truncate = (v: unknown): string => {
  const safe = redact(v);
  const encoded = typeof safe === "string" ? safe : JSON.stringify(safe ?? null, jsonSafe);
  const s = encoded ?? String(safe);
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…[${s.length} chars]` : s;
};

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

function requiredBank(bank: string | undefined): string {
  if (!bank?.trim()) throw new Error("bank is required");
  return bank;
}

/** Non-secret authenticated attribution. Never a token, digest or header. */
export interface AuditAttribution {
  principal_id: string;
  credential_id: string;
  policy_version: string;
}

export interface CallRecord {
  tool: string;
  input: unknown;
  status: "ok" | "error";
  result: unknown;
  duration_ms: number;
  workspace_name: string;
  /**
   * DOMAIN field: the registered peer who authored the content, or null. The
   * authenticated principal must NEVER be written here -- it travels in `auth`
   * below, because overloading this column would silently redefine authorship.
   */
  peer_name?: string | null;
  session_name?: string | null;
  client_label?: string | null;
  /** D6 (R18): the `arra_*` alias the caller used; `tool` is then its canonical name. */
  requested_as?: string | null;
  /** Present for admitted operations; absent only for legacy internal writes. */
  auth?: AuditAttribution | null;
}

/** Fixed sanitized counter for audit-write failures; never exception text. */
let auditFailures = 0;

export function auditFailureCount(): number {
  return auditFailures;
}

export async function logCall(rec: CallRecord): Promise<void> {
  try {
    // #103 fix round 2: caller-supplied NAME columns are recorded only in the
    // form the reader's codec accepts -- see `calls.recordableName.ts`. The
    // other columns need no such step: `workspace_name` is the admitted
    // policy scope, `tool` is a catalogue name (`auth/service.ts` audits no
    // unknown tool), and both metadata columns are `JSON.stringify` output,
    // which is always well-formed text.
    const session = recordableName(rec.session_name);
    const peer = recordableName(rec.peer_name);
    const invalidFields = [
      ...(session.invalid ? ["session_name"] : []),
      ...(peer.invalid ? ["peer_name"] : []),
    ];
    const tbl = await openCallLogTable();
    await tbl.add([
      {
        id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        workspace_name: rec.workspace_name,
        session_name: session.value,
        peer_name: peer.value,
        tool: rec.tool,
        status: rec.status,
        duration_ms: rec.duration_ms,
        // A FRESH wrapper-owned object every time: caller metadata is never
        // merged in, so a caller cannot forge or overwrite the auth block --
        // or the `invalid_fields` flag, which is present only when a name
        // column above was recorded as null INSTEAD of what was sent.
        h_metadata: JSON.stringify({
          input: truncate(rec.input),
          result: truncate(rec.result),
          // v3 adapter (R18 D6): the alias the caller actually named, e.g. arra_search.
          ...(rec.requested_as ? { requested_as: rec.requested_as } : {}),
          ...(rec.auth
            ? {
                auth: {
                  principal_id: rec.auth.principal_id,
                  credential_id: rec.auth.credential_id,
                  policy_version: rec.auth.policy_version,
                },
              }
            : {}),
          ...(invalidFields.length > 0 ? { invalid_fields: invalidFields } : {}),
        }),
        internal_metadata: rec.client_label
          ? JSON.stringify({ transport: { user_agent: truncate(rec.client_label) } })
          : null,
        created_at: Date.now(),
      },
    ]);
  } catch {
    // Best-effort, and deliberately NOT transactional with the operation it
    // audits: that operation already happened and is not rolled back here.
    // Only a fixed sanitized marker is emitted, never raw exception text,
    // which could carry store internals into the logs.
    auditFailures += 1;
    console.error("[call_log] audit_write_failed");
  }
}

export async function recent(bank: string, limit = 20, status?: string) {
  const scopedBank = requiredBank(bank);
  const tbl = await openCallLogTable();
  await tbl.checkoutLatest(); // a Table handle pins a version — see db.ts
  const predicates = [`workspace_name = ${quote(scopedBank)}`];
  if (status) predicates.push(`status = ${quote(status)}`);
  const rows = await tbl
    .query()
    .where(predicates.join(" AND "))
    .orderBy([
      { columnName: "created_at", ascending: false },
      { columnName: "id", ascending: false },
    ])
    .limit(Math.max(0, limit))
    .toArray();
  return rows.map((r: any) => ({
    id: r.id,
    workspace_name: r.workspace_name,
    tool: r.tool,
    status: r.status,
    duration_ms: wireInteger(r.duration_ms),
    at: wireTime(r.created_at),
    ...JSON.parse(r.h_metadata ?? "{}"),
  }));
}

export async function aggregate(bank: string) {
  const scopedBank = requiredBank(bank);
  const tbl = await openCallLogTable();
  await tbl.checkoutLatest();
  const rows = await tbl.query().where(`workspace_name = ${quote(scopedBank)}`).toArray();
  const byTool: Record<string, { calls: number; errors: number; total_ms: number }> = {};
  for (const r of rows as any[]) {
    const t = (byTool[r.tool] ??= { calls: 0, errors: 0, total_ms: 0 });
    t.calls++;
    if (r.status === "error") t.errors++;
    t.total_ms += Number(r.duration_ms ?? 0);
  }
  return {
    total: rows.length,
    tools: Object.fromEntries(
      Object.entries(byTool).map(([k, v]) => [
        k,
        { ...v, avg_ms: v.calls ? Math.round(v.total_ms / v.calls) : 0, total_ms: undefined },
      ]),
    ),
  };
}
