import { useState } from "react";
import type { LifecycleWriteOutcome } from "../api/evidenceReview";

type Mode = "idle" | "retire" | "supersede";

/** Retire/supersede a node (#29, #33 R12 -- brief item 4's "supersede/retire
 *  interactions"). Both are irreversible lifecycle events, so both are
 *  CONFIRM-GATED: clicking the top-level button only opens the form: the
 *  actual write fires from a second, explicit "confirm" click, never from
 *  the first click on a destructive action. `expectedRevisionId` (the CURRENT
 *  head, from `useKnowledge`) is supplied by the caller rather than read
 *  from this component's own props drift -- the write MUST pin the head it
 *  was shown, exactly like `publishRevision`'s `base_revision_id`, so a
 *  concurrent edit is refused rather than silently overtaken. */
export function LifecycleActions({
  nodeId,
  expectedRevisionId,
  busy,
  error,
  outcome,
  onRetire,
  onSupersede,
}: {
  nodeId: string | null;
  expectedRevisionId: string | null;
  busy: boolean;
  error: string | null;
  outcome: LifecycleWriteOutcome | null;
  onRetire: (expectedRevisionId: string, reason: string) => void;
  onSupersede: (expectedRevisionId: string, newNodeId: string, newRevisionId: string, reason: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [reason, setReason] = useState("");
  const [newNodeId, setNewNodeId] = useState("");
  const [newRevisionId, setNewRevisionId] = useState("");

  const disabled = nodeId === null || expectedRevisionId === null || busy;

  const cancel = () => {
    setMode("idle");
    setReason("");
    setNewNodeId("");
    setNewRevisionId("");
  };

  const confirmRetire = () => {
    if (expectedRevisionId === null || reason.trim() === "") return;
    onRetire(expectedRevisionId, reason.trim());
    cancel();
  };

  const confirmSupersede = () => {
    if (expectedRevisionId === null) return;
    if (newNodeId.trim() === "" || newRevisionId.trim() === "" || reason.trim() === "") return;
    onSupersede(expectedRevisionId, newNodeId.trim(), newRevisionId.trim(), reason.trim());
    cancel();
  };

  return (
    <section className="flex flex-col gap-2 border-b border-edge p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Lifecycle actions</h3>

      {disabled && mode === "idle" && (
        <p className="text-[11px] text-muted">pick a node with an accepted revision to retire or supersede it</p>
      )}

      {mode === "idle" && (
        <div className="flex gap-2">
          <button
            onClick={() => setMode("retire")}
            disabled={disabled}
            className="rounded border border-rose-400/40 px-2.5 py-1 text-[11px] text-rose-300 hover:bg-rose-400/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Retire…
          </button>
          <button
            onClick={() => setMode("supersede")}
            disabled={disabled}
            className="rounded border border-accent/40 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Supersede…
          </button>
        </div>
      )}

      {mode === "retire" && (
        <div className="flex flex-col gap-2 rounded border border-rose-400/40 bg-rose-400/5 p-2">
          <p className="text-[11px] text-rose-300">
            Retire this node. This is a lifecycle event, not a delete -- the revision stays, but the node stops
            being recall-eligible.
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="reason (required)…"
            aria-label="Retire reason (required)"
            rows={2}
            className="rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            <button
              onClick={confirmRetire}
              disabled={busy || reason.trim() === ""}
              className="rounded bg-rose-500 px-2.5 py-1 text-[11px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "retiring…" : "Confirm retire"}
            </button>
            <button onClick={cancel} className="rounded border border-edge px-2.5 py-1 text-[11px] text-muted">
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "supersede" && (
        <div className="flex flex-col gap-2 rounded border border-accent/40 bg-accent/5 p-2">
          <p className="text-[11px] text-muted">
            Supersede with another node's accepted revision. Both ids are minted/known elsewhere in this app --
            there is no lookup here, matching the rest of this POC's "caller mints/knows ids" pattern.
          </p>
          <input
            value={newNodeId}
            onChange={(e) => setNewNodeId(e.target.value)}
            placeholder="successor node_id…"
            aria-label="Successor node id"
            className="rounded border border-edge bg-ink px-2 py-1 font-mono text-xs text-slate-100 outline-none focus:border-accent"
          />
          <input
            value={newRevisionId}
            onChange={(e) => setNewRevisionId(e.target.value)}
            placeholder="successor's current revision_id…"
            aria-label="Successor's current revision id"
            className="rounded border border-edge bg-ink px-2 py-1 font-mono text-xs text-slate-100 outline-none focus:border-accent"
          />
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="reason (required)…"
            aria-label="Supersede reason (required)"
            rows={2}
            className="rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            <button
              onClick={confirmSupersede}
              disabled={busy || newNodeId.trim() === "" || newRevisionId.trim() === "" || reason.trim() === ""}
              className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "superseding…" : "Confirm supersede"}
            </button>
            <button onClick={cancel} className="rounded border border-edge px-2.5 py-1 text-[11px] text-muted">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error !== null && <p className="text-[11px] text-rose-300">{error}</p>}
      {outcome !== null && outcome.outcome !== "conflict" && (
        <p className="text-[11px] text-accent">{outcome.outcome} — lifecycle history refreshed below</p>
      )}
    </section>
  );
}
