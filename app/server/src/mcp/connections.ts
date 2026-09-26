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

/** Same bound, non-null: for columns the schema declares NOT NULL. */
const truncateRequired = (v: string): string =>
  v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}…[${v.length} chars]` : v;

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

/**
 * Latch for "this store has no `connections` table".
 *
 * A store that lacks the table will lack it for every subsequent request too,
 * so retrying per call buys nothing and costs a log line each time. The
 * DEFAULT `ARRA_DATA_DIR` (`../data`) is exactly this case -- measured: 0
 * tables -- so without the latch an ordinary deployment prints
 * `fold_write_failed` on every audited request forever. The suite printed it
 * 18 times in one run.
 *
 * Deliberately NOT "create the table if missing": that is a schema write into
 * an operator's store from the request path, which is not this module's
 * authority to take.
 */
let tableAbsent = false;

export function connectionFoldFailureCount(): number {
  return foldFailures;
}

/**
 * Test seam: clears the latch, the cached connection and the failure count.
 *
 * It does NOT re-point the store. `DATA_DIR` is captured from the environment
 * at module load (`storage.ts`), so setting `ARRA_DATA_DIR` after import has
 * no effect -- a test that needs a different store must run in its own
 * process with the variable already set. Learned by writing a probe that
 * reset the state, changed the env var, and kept writing to the old path.
 */
export function resetConnectionFoldState(): void {
  handle = null;
  tableAbsent = false;
  foldFailures = 0;
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
  if (tableAbsent) return;
  try {
    const tbl = await table();
    await tbl.checkoutLatest(); // a Table handle pins a version — see db.ts
    // Truncate BEFORE the key, not after. `label` is client-supplied and
    // unbounded; storing a trimmed value while keying on the full one would
    // give two 5000-char labels distinct ids and identical stored text, so the
    // table would show duplicate-looking rows nobody could tell apart.
    const label = truncateRequired(event.label);
    const id = foldId(event.workspace_name, event.method, event.principal, label);
    // MILLISECONDS, as a plain JS number. The physical column IS microseconds
    // (`timestamp[us]`, storage.ts's `TARGET_SCHEMA`); apache-arrow's writer
    // multiplies a plain-object numeric/Date cell by 1000 on the way in
    // (`node_modules/apache-arrow/visitor/set.mjs`), so passing millis here is
    // what lands the exact microsecond value on disk. Measured, all four
    // candidates, write-then-read against a real table copy (LANCEDB-FACTS.md
    // §1-2, via `toArray()`, the client's lossy row accessor):
    //
    //   BigInt micros  -> WRITE FAILS: "Invalid mix of BigInt and other type"
    //   number micros  -> reads back 1790023408801999.8, a float (1000x wrong)
    //   new Date(ms)   -> reads back 1790023408802, exact
    //   number millis  -> reads back 1790023408802, exact
    //
    // #105 is misdiagnosed for this table: the kernel never reads through
    // `toArray()`. `context.listConnections` reads raw microseconds via
    // `decodeArrowRows`/`rawRows` (storage.ts), which returns the exact BigInt
    // this write produced -- these rows DO read (measured: see
    // docs/overnight/DECISIONS.md R1, `.tmp/understand/issue-105`). The real
    // #75 defect was a different table's producer (the dev-seed script's
    // sub-millisecond `workspaces.created_at`), fixed at its source in
    // app/just/scripts/create_target19_dataset.py, not here.
    const now = Date.now();

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
    const firstSeen = prior === undefined ? now : (prior.first_seen as number);

    const row = {
      id,
      workspace_name: event.workspace_name,
      method: event.method,
      principal: event.principal,
      label,
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
  } catch (error) {
    // Best-effort and deliberately NOT transactional with the request it
    // describes: that request already happened and is not rolled back here.
    // Same discipline as `calls.ts` — a fixed sanitized marker only, never raw
    // exception text, which could carry store internals into the logs.
    //
    // "Table absent" is reported ONCE and then latched off. It is a standing
    // configuration fact, not an incident, and repeating it per request would
    // bury the transient failures that ARE incidents.
    if (error instanceof Error && /was not found|Table '.*' was not found/i.test(error.message)) {
      tableAbsent = true;
      console.error("[connections] fold_disabled_table_absent");
      return;
    }
    foldFailures += 1;
    console.error("[connections] fold_write_failed");
  }
}
