// Shared mutable state for the connection fold, split out of connections.ts
// (Nat style: one exported function per file). Not a public entry point --
// only connections.foldConnection.ts, connections.connectionFoldFailureCount.ts
// and connections.resetConnectionFoldState.ts import it, mirroring
// policy.registry.state.ts's "single owner module for shared identity"
// discipline. Deliberately exports plain values only, never functions: a
// function here would need its own file under this same ratchet.

/**
 * `foldFailures`: fixed sanitized counter for fold-write failures; never
 * exception text. `tableAbsent`: latch for "this store has no `connections`
 * table" -- a store that lacks the table will lack it for every subsequent
 * request too, so retrying per call buys nothing and costs a log line each
 * time. See connections.foldConnection.ts for the full rationale.
 */
export const foldState = {
  foldFailures: 0,
  tableAbsent: false,
};

/**
 * Per-id queue so overlapping folds for the SAME (workspace, method,
 * principal, label) key run one at a time instead of interleaving. See
 * connections.foldConnection.ts for the fix-round finding this exists to
 * address.
 */
export const foldQueues = new Map<string, Promise<void>>();

/** Upper bound on duplicate rows one fold reads back and heals; see the fold. */
export const MAX_HEAL_ROWS = 64;

/** Mirrors `calls.ts` — the log and the fold share one truncation rule so a
 *  hostile user-agent cannot bloat one table by going through the other. */
export const MAX_FIELD = 2000;

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
