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

import { openConnectionsTable } from "./connections.openConnectionsTable";

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

/** Upper bound on duplicate rows one fold reads back and heals; see the fold. */
const MAX_HEAL_ROWS = 64;

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
  /** DECISIONS.md R19: the AUTH method (SPEC §7.2), `bearer` today; not the transport. */
  method: string;
  /**
   * DECISIONS.md R5 (#102): the CREDENTIAL id, matching SPEC §7.2 ("token id
   * or oauth client_id") -- despite the field's name, this is deliberately
   * NOT the principal/person/service id the credential belongs to (one
   * principal can hold several credentials, each a distinct row here). See
   * `composition.ts`'s `logCall` wrapper, which is the one caller and states
   * the same ruling. Never a bearer token or a digest either way.
   */
  principal: string;
  /** Client-supplied label. Untrusted text — truncated, never interpreted. */
  label: string;
  user_agent?: string | null;
  remote_ip?: string | null;
  /** Non-null only when this request WAS a tool call; names the tool. */
  tool?: string | null;
}

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
 * Test seam: clears the latch, the failure count and any pending per-id fold
 * queue. The cached connection is no longer cleared here: it moved to
 * `connections.openConnectionsTable.ts`, whose header records the
 * measurement showing it holds no state a reset would need to drop.
 *
 * It does NOT re-point the store. `DATA_DIR` is captured from the environment
 * at module load (`storage.ts`), so setting `ARRA_DATA_DIR` after import has
 * no effect -- a test that needs a different store must run in its own
 * process with the variable already set. Learned by writing a probe that
 * reset the state, changed the env var, and kept writing to the old path.
 */
export function resetConnectionFoldState(): void {
  tableAbsent = false;
  foldFailures = 0;
  foldQueues.clear();
}

/**
 * Per-id queue so overlapping folds for the SAME (workspace, method,
 * principal, label) key run one at a time instead of interleaving.
 *
 * #102 fix-round finding (verifier, 2026-09-26): `foldConnection` is launched
 * fire-and-forget from `composition.ts` and the caller's response returns
 * before it settles, so the NEXT admitted request for the same caller can
 * start a second `foldConnection` before the first one's read-modify-write
 * has committed — even when the two requests were sequential and AWAITED on
 * the client side. Measured: `Promise.all` of 5 concurrent folds for one
 * caller produced 5 ROWS SHARING ONE id (every fold read "no prior row" and
 * added), which the reader then could not resolve -- before fix round 2 it
 * refused the WHOLE page as `integrity_failure`; it now withholds and reports
 * that one id (`operations.listPage.ts`). Queueing
 * per id removes the interleave without awaiting the fold on the request's
 * hot path: the caller of `foldConnection` still gets an immediately-pending
 * promise it can fire-and-forget exactly as before; only the ACTUAL
 * read-modify-write bodies for one id are serialized against each other, at
 * the same key granularity the row already has.
 */
const foldQueues = new Map<string, Promise<void>>();

/**
 * Fold one request into the caller's row.
 *
 * Read-modify-write rather than a merge expression: LanceDB's merge-insert
 * cannot express "requests = requests + 1" against the row it is matching, and
 * a blind overwrite would reset the counters this table exists to accumulate.
 *
 * Concurrency for the SAME id is now serialized by `foldQueues` above, so the
 * lost-increment race this comment used to accept no longer happens for a
 * single caller. It remains true across DIFFERENT ids (unrelated keys never
 * wait on each other) and this is still deliberately NOT awaited by the
 * request path that triggers it (`composition.ts`): these are population
 * statistics, not an audit trail — `mcp_calls` is the audit trail, it is
 * append-only, and it loses nothing.
 */
export async function foldConnection(event: ConnectionEvent): Promise<void> {
  if (tableAbsent) return;
  // Truncate and compute `id` BEFORE queueing: the queue key IS the fold key,
  // and this mirrors the pre-existing ordering ("truncate before the key").
  // Inside its own try, like every other step of the fold (fix-round 2
  // finding): a throw here used to escape as a REJECTION, which
  // `composition.ts`'s fire-and-forget `.catch` swallowed uncounted.
  let label: string;
  let id: string;
  try {
    label = truncateRequired(event.label);
    id = foldId(event.workspace_name, event.method, event.principal, label);
  } catch {
    foldFailures += 1;
    console.error("[connections] fold_write_failed");
    return;
  }
  const previous = foldQueues.get(id) ?? Promise.resolve();
  // `performFold` never rejects (its own try/catch turns every failure into a
  // counter/log line), so `queued` never rejects either — this chain cannot
  // poison itself for the next caller of the same id.
  const queued = previous.then(() => performFold(event, id, label));
  foldQueues.set(id, queued);
  try {
    await queued;
  } finally {
    // Bounded cleanup: drop the entry once nobody has queued behind us, so a
    // caller seen only once does not keep its settled promise forever. A
    // caller queued behind us in the meantime owns the entry now — leave it.
    if (foldQueues.get(id) === queued) foldQueues.delete(id);
  }
}

async function performFold(event: ConnectionEvent, id: string, label: string): Promise<void> {
  try {
    const tbl = await openConnectionsTable();
    await tbl.checkoutLatest(); // a Table handle pins a version — see db.ts
    // `label` and `id` are computed by the caller (`foldConnection`), BEFORE
    // truncation was moved there so the queue key and the stored key can
    // never disagree — see the ordering note on `foldConnection` above.
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

    // EVERY stored row for this id, not just one (fix-round 2, upgrade-risk
    // finding). `foldQueues` serializes ONE process; a second writer process
    // on the same `ARRA_DATA_DIR` can still leave duplicates. Reading one of
    // them and then deleting all of them (below) would silently drop the
    // others' counts, so the fold SUMS them instead and the next fold for the
    // key heals it into one row. Bounded: past `MAX_HEAL_ROWS` duplicates the
    // excess is under-counted, the safe direction for population statistics.
    const existing = (await tbl
      .query()
      .where(`id = ${quote(id)}`)
      .limit(MAX_HEAL_ROWS)
      .toArray()) as Record<string, unknown>[];

    let priorRequests = 0n;
    let priorToolCalls = 0n;
    let latest: Record<string, unknown> | undefined;
    for (const stored of existing) {
      priorRequests += BigInt(stored.requests as number | bigint);
      priorToolCalls += BigInt(stored.tool_calls as number | bigint);
      if (latest === undefined || (stored.last_seen as number) > (latest.last_seen as number)) latest = stored;
    }
    // `first_seen` is the one column a repeat visit must NOT move. Reading it
    // back from the stored row rather than recomputing keeps it honest across
    // restarts; only a genuinely new key gets `now`. Across duplicates, the
    // EARLIEST wins -- the caller was first seen by whichever writer saw it first.
    const firstSeen =
      existing.length === 0
        ? now
        : existing.map((stored) => stored.first_seen as number).reduce((a, b) => (b < a ? b : a));

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
      last_tool: event.tool ?? (latest === undefined ? null : (latest.last_tool as string | null)),
    };

    if (existing.length === 0) {
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
