// The connection fold (#102) — one row per caller, not one row per call.
//
//   `mcp_calls` answers "what happened". `connections` answers "who is here".
//   Both are in the enforced 19; only the first had a writer, so the second
//   read zero forever and the overview page had to explain the zero rather
//   than show it.
//
// A fold, deliberately, not a log: `mcp_calls` already carries the per-call
// detail, and duplicating it here would make the table grow with traffic while
// answering a question nobody asks of it. What is missing from the call log is
// the SHAPE of the caller population — how many distinct principals, on which
// transport, first seen when, how much of their traffic is tool calls. That is
// bounded by the number of callers, not by the number of requests.

import { connect } from "@lancedb/lancedb";
import { DATA_DIR, storageOptions } from "../storage";

const TABLE = "connections";

/** Mirrors `calls.ts` — the log and the fold share one truncation rule so a
 *  hostile user-agent cannot bloat one table by going through the other. */
const MAX_FIELD = 2000;

const truncate = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  return v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}…[${v.length} chars]` : v;
};

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * The fold key.
 *
 * `id` is DERIVED from (workspace, method, principal, label) rather than
 * minted, because the whole point is that the second request from the same
 * caller finds the first row instead of creating a sibling. A random id here
 * would turn the fold back into a log with extra steps.
 *
 * Encoded with a unit separator that cannot occur in any of the parts after
 * `storedName`/`storedText` validation, so two different keys can never
 * collide by concatenation ("a|b" + "c" vs "a" + "b|c").
 */
const SEP = "\u001f";
const foldId = (workspace: string, method: string, principal: string, label: string): string =>
  `k_${Buffer.from([workspace, method, principal, label].join(SEP), "utf8").toString("base64url")}`;

export interface ConnectionEvent {
  workspace_name: string;
  /** Transport family: "http", "mcp", or "unknown" when the caller did not say. */
  method: string;
  /** Authenticated principal id. Never a token, credential or digest. */
  principal: string;
  /** Client-supplied label. Untrusted text — truncated, never interpreted. */
  label: string;
  user_agent?: string | null;
  remote_ip?: string | null;
  /** Non-null only when this request WAS a tool call; names the tool. */
  tool?: string | null;
}

let handle: Awaited<ReturnType<typeof connect>> | null = null;

/** Fixed sanitized counter for fold-write failures; never exception text. */
let foldFailures = 0;

export function connectionFoldFailureCount(): number {
  return foldFailures;
}

async function table() {
  handle ??= await connect(DATA_DIR, { storageOptions: storageOptions() });
  return handle.openTable(TABLE);
}

/**
 * Fold one request into the caller's row.
 *
 * Read-modify-write rather than a merge expression: LanceDB's merge-insert
 * cannot express "requests = requests + 1" against the row it is matching, and
 * a blind overwrite would reset the counters this table exists to accumulate.
 *
 * The race is real and bounded: two concurrent requests from the SAME caller
 * can both read `requests: 4` and both write `5`, losing one increment. That
 * is accepted knowingly. These are population statistics, not an audit trail —
 * `mcp_calls` is the audit trail, it is append-only, and it loses nothing. A
 * lock here would put contention on the hot request path to protect a number
 * whose only consumer is a dashboard. Under-counting is also the SAFE
 * direction: this row can never claim more traffic than actually happened.
 */
export async function foldConnection(event: ConnectionEvent): Promise<void> {
  try {
    const tbl = await table();
    await tbl.checkoutLatest(); // a Table handle pins a version — see db.ts
    const id = foldId(event.workspace_name, event.method, event.principal, event.label);
    // MICROSECONDS, not milliseconds. `connections.first_seen` / `last_seen`
    // are `timestamp[us]`, unlike `mcp_calls.created_at` which is a raw int64
    // of millis -- the two operations tables genuinely differ, and
    // `context.encodeConnectionRow.ts` says so at the read end.
    //
    // Both halves of this were found by running the writer against a real
    // table copy and then feeding the rows back through the READ encoder.
    // Both were green at write time and threw `integrity_failure` at read
    // time -- the same shape as #75, where a kernel is wired and unusable.
    //
    //   1. UNIT. `Date.now()` is millis. Stored as micros it is both the
    //      wrong instant (20 days past the epoch) and not millisecond-aligned,
    //      and `storedTimestamp` rejects an unaligned microsecond count.
    //
    //   2. TYPE. `BigInt`, not a JS number. As a plain number the value
    //      round-tripped through float64 and came back 1790023408801999.8 --
    //      a non-integer, so rejected again. ~1.8e15 is well inside
    //      Number.MAX_SAFE_INTEGER, so this is NOT an overflow; the precision
    //      is lost inside the store's own conversion, and BigInt is what pins
    //      the int64 path. Measured: as a number 2 of 4 rows failed to encode,
    //      as BigInt 4 of 4 pass.
    const now = BigInt(Date.now()) * 1000n;

    const existing = (await tbl
      .query()
      .where(`id = ${quote(id)}`)
      .limit(1)
      .toArray()) as Record<string, unknown>[];

    const prior = existing[0];
    const priorRequests = prior === undefined ? 0n : BigInt(prior.requests as number | bigint);
    const priorToolCalls = prior === undefined ? 0n : BigInt(prior.tool_calls as number | bigint);
    // `first_seen` is the one column a repeat visit must NOT move. Reading it
    // back from the stored row rather than recomputing keeps it honest across
    // restarts; only a genuinely new key gets `now`.
    const firstSeen = prior === undefined ? now : BigInt(prior.first_seen as number | bigint);

    const row = {
      id,
      workspace_name: event.workspace_name,
      method: event.method,
      principal: event.principal,
      label: event.label,
      user_agent: truncate(event.user_agent),
      remote_ip: truncate(event.remote_ip),
      first_seen: firstSeen,
      last_seen: now,
      requests: priorRequests + 1n,
      // A tool call is ALSO a request, so `tool_calls <= requests` always. The
      // two are not disjoint buckets and must not be presented as such.
      tool_calls: event.tool ? priorToolCalls + 1n : priorToolCalls,
      last_tool: event.tool ?? (prior === undefined ? null : (prior.last_tool as string | null)),
    };

    if (prior === undefined) {
      await tbl.add([row]);
    } else {
      await tbl.delete(`id = ${quote(id)}`);
      await tbl.add([row]);
    }
  } catch {
    // Best-effort and deliberately NOT transactional with the request it
    // describes: that request already happened and is not rolled back here.
    // Same discipline as `calls.ts` — a fixed sanitized marker only, never raw
    // exception text, which could carry store internals into the logs.
    foldFailures += 1;
    console.error("[connections] fold_write_failed");
  }
}
