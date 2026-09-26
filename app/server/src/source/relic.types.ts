/**
 * Raw JSON shapes this adapter reads from the `relic` CLI (`--json` mode),
 * and the adapter's own trusted configuration. These are PARSE targets, not
 * a governed contract codec: relic is a local, trusted tool, but its output
 * still crosses a subprocess/JSON boundary, so every field the adapter
 * actually uses is defensively type-checked in `relic.runRelic.ts`'s
 * callers, never assumed.
 *
 * Measured against a real `relic` binary, 2026-09-26 (see the contract doc's
 * "what is read" section for the exact commands and sample output this was
 * measured from).
 */

/** Trusted, explicit configuration -- never request-selectable (DESIGN.md:
 *  "Connector principal is not speaker identity"; analysis-28.json Unit D
 *  risk 6: never open or modify the user's live relic index from a request). */
export type RelicAdapterConfig = {
  /** Absolute path to the `relic` executable (or a fake script in tests).
   *  Never resolved from `$PATH` at call time, so a test's fake binary can
   *  never be shadowed by whatever `relic` a shell happens to find. */
  readonly binPath: string;
  readonly timeoutMs: number;
  /** Bounded stdout capture -- a runaway or malicious binary must not be
   *  able to exhaust memory. Matches the spirit of every other bounded read
   *  in this codebase (`knowledge/transport.ts`'s 1 MiB body cap, etc). */
  readonly maxOutputBytes: number;
};

/** One row of `relic sessions --json` / `relic session <id> --json`'s
 *  `sessions[]` array. Only the fields this adapter actually reads. */
export type RelicSessionRow = {
  session_uuid: string;
  file_path: string;
  repo: string;
  source: string;
  /** `"session"` for the top-level transcript, `"subagent"` (or another
   *  non-session value) for a child transcript sharing the same
   *  `session_uuid`. `relic.getSession.ts` trusts only `tier === "session"`
   *  rows -- see its header comment for why. */
  tier: string;
  title?: string | null;
  description?: string | null;
  started_at: string | null;
  ended_at: string | null;
};

export type RelicSessionCommandOutput = {
  sessions: RelicSessionRow[];
};

/** One row of `relic search <query> --json`'s `hits[]` array. */
export type RelicSearchHit = {
  session_uuid: string;
  file_path: string;
  repo: string;
  source: string;
  seq: number;
  role: string;
  ts: string;
  text: string;
};

export type RelicSearchCommandOutput = {
  hits: RelicSearchHit[];
};

/** One row of `relic tail <id> --json`'s `turns[]` array. */
export type RelicTailTurn = {
  seq: number;
  role: string;
  ts: string;
  text: string;
};

export type RelicTailCommandOutput = {
  file: string;
  title: string | null;
  turns: RelicTailTurn[];
};
