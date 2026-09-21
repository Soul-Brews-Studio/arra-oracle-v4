/** Which server answered, and which bank and workspace the numbers below it
 *  were counted in.
 *
 * `version` and `auth` come from `GET /health`, which is the PUBLIC liveness
 * route -- no bank, no token (see the trap documented in `api/client.ts`,
 * where `/api/health` is the gated one). That matters for reading a dash
 * here: every other unknown on this page could be a token problem, but an
 * unknown version cannot be. If this line is dashed the server did not
 * answer at all, and nothing below it is worth trusting either.
 *
 * Bank and workspace are printed rather than assumed because they are the
 * scope of every count on the page. "2 peers" is meaningless without them --
 * the same server answers differently for another workspace, and a reader
 * who has switched workspaces and forgotten will otherwise read a correct
 * number as a wrong one.
 */
export function HealthLine({
  bank,
  workspace,
  version,
  auth,
  probedAt = null,
  requestCount = null,
  elapsedMs = null,
  onRefreshAll,
  refreshing = false,
}: {
  bank: string;
  workspace: string;
  /** `/health`'s `version`, or null when it did not answer. */
  version: string | null;
  /** `/health`'s `auth` mode, printed verbatim -- "bearer" and "off" are the
   *  server's own words and renaming them would break the match against a
   *  config file somebody is reading beside this screen. */
  auth: string | null;
  /** Local clock time the probe run finished, already formatted. */
  probedAt?: string | null;
  /** How many requests that run took, so the page states its own cost. */
  requestCount?: number | null;
  elapsedMs?: number | null;
  onRefreshAll?: () => void;
  refreshing?: boolean;
}) {
  const reachable = version !== null || auth !== null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-edge px-4 py-2 text-[11px] text-muted">
      <span className="text-slate-100">{bank}</span>
      <span className="text-edge">·</span>
      <span title="the workspace every count on this page is scoped to">
        workspace <span className="text-slate-100">{workspace}</span>
      </span>
      <span className="text-edge">·</span>
      <span title={reachable ? "GET /health — public route, no token involved" : "GET /health did not answer: the server is unreachable, not a token problem"}>
        arra-oracle-v4 <span className={reachable ? "text-slate-100" : "text-[#f0a35e]"}>{version ?? "—"}</span>
      </span>
      <span className="text-edge">·</span>
      <span>
        auth <span className="text-slate-100">{auth ?? "—"}</span>
      </span>

      <span className="ml-auto flex items-center gap-2">
        {probedAt !== null && <span title="local clock when this page last probed the server">probed {probedAt}</span>}
        {requestCount !== null && (
          <span title="requests this page made — its own cost, stated rather than hidden">
            {requestCount} requests
          </span>
        )}
        {elapsedMs !== null && <span className="font-mono">{elapsedMs} ms</span>}
        {onRefreshAll !== undefined && (
          <button
            onClick={onRefreshAll}
            disabled={refreshing}
            title="re-run every probe on this page"
            className="rounded border border-accent/40 px-2.5 py-1 font-medium text-accent hover:bg-accent/10 disabled:opacity-40"
          >
            {refreshing ? "refreshing…" : "⟳ refresh all"}
          </button>
        )}
      </span>
    </div>
  );
}
