import { health } from "../api/client";

/** Status colour follows MEANING, not just 2xx/4xx -- mirrors v1's
 *  StatusBadge, but copied rather than imported: v2 stays inside its own
 *  directory so its build doesn't pick up a dependency on a sibling POC. */
function StatusBadge({ status }: { status: number }) {
  const tone =
    status === 0
      ? "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30"
      : status < 300
        ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
        : status === 409
          ? "bg-amber-500/15 text-amber-300 ring-amber-500/30"
          : status === 503
            ? "bg-orange-500/15 text-orange-300 ring-orange-500/30"
            : status < 500
              ? "bg-yellow-500/15 text-yellow-300 ring-yellow-500/30"
              : "bg-rose-500/15 text-rose-300 ring-rose-500/30";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ring-1 ${tone}`}>
      {status === 0 ? "network" : status}
    </span>
  );
}

/** Top bar: bank / workspace / token, plus a ping. Controlled -- inputs are
 *  fully owned by the parent, and the ping result is handed straight to
 *  `onHealth` rather than kept here, so this component holds no state of
 *  its own even though it is the one that calls `health(bank)`. */
export function WorkspaceBar({
  bank,
  workspace,
  token,
  onBank,
  onWorkspace,
  onToken,
  onHealth,
  healthStatus,
}: {
  bank: string;
  workspace: string;
  token: string;
  onBank: (v: string) => void;
  onWorkspace: (v: string) => void;
  onToken: (v: string) => void;
  onHealth: (status: number) => void;
  healthStatus: number | null;
}) {
  const ping = () => {
    health(bank).then((result) => onHealth(result.status));
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge px-4 py-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor="ws-bar-bank" className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
          bank
        </label>
        <input
          id="ws-bar-bank"
          value={bank}
          onChange={(e) => onBank(e.target.value)}
          placeholder="default"
          className="w-36 rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <label htmlFor="ws-bar-workspace" className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
          workspace
        </label>
        <input
          id="ws-bar-workspace"
          value={workspace}
          onChange={(e) => onWorkspace(e.target.value)}
          placeholder="workspace_name"
          className="w-36 rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <label htmlFor="ws-bar-token" className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
          token
        </label>
        <input
          id="ws-bar-token"
          value={token}
          onChange={(e) => onToken(e.target.value)}
          type="password"
          placeholder="bearer…"
          className="w-36 rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>
      <div className="flex items-center gap-2 pt-0.5">
        <button
          onClick={ping}
          aria-label="Ping the server health endpoint"
          className="rounded border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-accent"
        >
          ping
        </button>
        {healthStatus !== null && <StatusBadge status={healthStatus} />}
      </div>
    </div>
  );
}
