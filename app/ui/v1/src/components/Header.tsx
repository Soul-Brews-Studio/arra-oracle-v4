import { StatusBadge } from "./StatusBadge";

export function Header({
  bank,
  token,
  onBank,
  onToken,
  onPing,
  healthStatus,
}: {
  bank: string;
  token: string;
  onBank: (v: string) => void;
  onToken: (v: string) => void;
  onPing: () => void;
  healthStatus: number | null;
}) {
  return (
    <header className="border-b border-edge bg-panel/60 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-3">
        <h1 className="text-sm font-semibold text-slate-100">
          arra-oracle-v4 <span className="text-muted">knowledge explorer</span>
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted">bank</label>
          <input
            value={bank}
            onChange={(e) => onBank(e.target.value)}
            className="w-32 rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
            placeholder="default"
          />
          <label className="text-xs text-muted">token</label>
          <input
            value={token}
            onChange={(e) => onToken(e.target.value)}
            type="password"
            className="w-40 rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
            placeholder="bearer…"
          />
          <button
            onClick={onPing}
            className="rounded border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/20"
          >
            ping
          </button>
          {healthStatus !== null && <StatusBadge status={healthStatus} />}
        </div>
      </div>
    </header>
  );
}
