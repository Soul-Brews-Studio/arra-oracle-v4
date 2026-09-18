// The call log (SPEC §6.3) — non-optional.
//
//   "An MCP server you cannot watch is one you are trusting on faith.
//    'The model said it saved that' is not evidence a row exists."
//
// Successes AND failures. A call that errored is the one you most want to read
// later — both of digger-node's refusal-message fixes were found by reading its
// own call log, not by a test.

import { connect } from "@lancedb/lancedb";
import { DATA_DIR, storageOptions } from "../storage";

const TABLE = "mcp_calls";

/** Inputs are truncated AT WRITE TIME, not at read time — otherwise a 100 KB
 *  argument blob lives in the log forever and is only trimmed when someone
 *  happens to look. */
const MAX_FIELD = 2000;

const truncate = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…[${s.length} chars]` : s;
};

export interface CallRecord {
  tool: string;
  input: unknown;
  status: "ok" | "error";
  result: unknown;
  duration_ms: number;
  workspace_name: string;
  peer_name?: string | null;
  session_name?: string | null;
}

let handle: Awaited<ReturnType<typeof connect>> | null = null;

async function table() {
  handle ??= await connect(DATA_DIR, { storageOptions: storageOptions() });
  return handle.openTable(TABLE);
}

export async function logCall(rec: CallRecord): Promise<void> {
  try {
    const tbl = await table();
    await tbl.add([
      {
        id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        workspace_name: rec.workspace_name,
        session_name: rec.session_name ?? null,
        peer_name: rec.peer_name ?? null,
        tool: rec.tool,
        status: rec.status,
        duration_ms: rec.duration_ms,
        h_metadata: JSON.stringify({
          input: truncate(rec.input),
          result: truncate(rec.result),
        }),
        internal_metadata: null,
        created_at: Date.now(),
      },
    ]);
  } catch (e) {
    // A failing audit trail must not take down the call it is auditing. Say so
    // on stderr rather than swallowing it — a silently broken log is worse than
    // no log, because /health would still claim one exists.
    console.error(`[call_log] write failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function recent(limit = 20, status?: string) {
  const tbl = await table();
  await tbl.checkoutLatest(); // a Table handle pins a version — see db.ts
  let q = tbl.query();
  if (status) q = q.where(`status = '${status.replace(/'/g, "''")}'`);
  const rows = await q.limit(limit).toArray();
  return rows
    // Number() on BOTH sides. `bigint - bigint` yields a bigint, and Array.sort
    // then throws "Conversion from 'BigInt' to 'number' is not allowed" — at the
    // sort, not at the subtraction, so the stack points at the wrong line.
    .sort((a: any, b: any) => Number(b.created_at) - Number(a.created_at))
    .map((r: any) => ({
      tool: r.tool,
      status: r.status,
      duration_ms: Number(r.duration_ms),
      at: new Date(Number(r.created_at)).toISOString(),
      ...JSON.parse(r.h_metadata ?? "{}"),
    }));
}

export async function aggregate() {
  const tbl = await table();
  await tbl.checkoutLatest();
  const rows = await tbl.query().toArray();
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
