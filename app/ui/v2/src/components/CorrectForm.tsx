import { useState } from "react";
import type { PublishInput, RevisionRow } from "../api/knowledge";
import { buildCorrection } from "../state/buildCorrection";
import type { CiteTarget, LinkDraft } from "../state/linkDraft.types";
import { LinkEditor } from "./LinkEditor";

const INPUT =
  "rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent";

/** The #33 AC1 "correct" interaction -- deliberately NOT the publish form
 *  with a different type picked. It writes a NEW `correction` node whose
 *  link 0 is `corrects` -> the exact revision chosen here
 *  (`state/buildCorrection` owns the payload), and leaves that revision
 *  untouched. `revisions` arrive newest first; the head is the default. */
export function CorrectForm({
  revisions,
  citeTargets,
  disabled,
  disabledReason,
  publishing,
  mintId,
  onCorrect,
}: {
  revisions: RevisionRow[];
  citeTargets: CiteTarget[];
  disabled: boolean;
  disabledReason?: string;
  publishing: boolean;
  mintId: () => string;
  onCorrect: (input: PublishInput) => void;
}) {
  // "" = follow the head, so a revise-then-correct targets the NEW head
  // unless another revision was picked on purpose.
  const [revisionId, setRevisionId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  const chosen = revisions.find((r) => r.id === revisionId) ?? revisions[0] ?? null;
  const canSubmit = !disabled && !publishing && chosen !== null && title !== "" && body !== "";

  const submit = () => {
    if (!canSubmit) return;
    const built = buildCorrection({
      newNodeId: mintId(),
      // The pair comes from ONE row, so it cannot mix a node id with another
      // node's revision while a selection change is still settling.
      corrected: chosen === null ? null : { node_id: chosen.node_id, revision_id: chosen.id },
      title,
      body,
      body_format: "text",
      change_reason: reason,
      extraLinks: links,
    });
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    onCorrect(built.input);
    setTitle("");
    setBody("");
    setReason("");
    setLinks([]);
  };

  return (
    <section className="flex flex-col gap-2 border-t border-edge p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Correct</h3>
      <p className="text-[11px] text-muted">
        Records that a revision was wrong without rewriting it. This publishes a new node of type{" "}
        <code>correction</code> whose first link is <code>corrects</code> → the revision picked below. That
        revision stays exactly as published, and the correction shows up as reverse evidence on it (Evidence tab).
        To change this node&apos;s own text, publish a revision instead.
      </p>
      {disabled && disabledReason && <p className="text-xs text-muted">{disabledReason}</p>}
      {/* #33 AC2 round 4: a <select> is as wide as its longest option, and
          these options carry revision titles -- one 114-char title made it
          671px and scrolled the whole view sideways at 375px. `min-w-0
          max-w-full` caps it at the row; the option text truncates instead. */}
      <label className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted">
        <span className="uppercase tracking-wide">corrects</span>
        <select
          aria-label="revision to correct"
          value={chosen?.id ?? ""}
          onChange={(e) => setRevisionId(e.target.value)}
          className="min-w-0 max-w-full flex-1 rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100"
        >
          {revisions.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.revision_no} — {r.title}
            </option>
          ))}
        </select>
      </label>
      <input aria-label="correction title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="correction title…" className={INPUT} />
      <textarea
        aria-label="correction body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="what was wrong, and what is right…"
        rows={3}
        className={INPUT}
      />
      <input aria-label="correction reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="change reason (optional)…" className={INPUT} />
      <LinkEditor drafts={links} onChange={setLinks} citeTargets={citeTargets} />
      {errors.map((e) => (
        <p key={e} className="text-[11px] text-rose-300">
          {e}
        </p>
      ))}
      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="rounded border border-[#f0a35e]/40 bg-[#f0a35e]/10 px-2 py-1.5 text-xs font-medium text-[#f0a35e] hover:bg-[#f0a35e]/20 disabled:opacity-40"
      >
        {publishing ? "recording…" : "record correction"}
      </button>
    </section>
  );
}
