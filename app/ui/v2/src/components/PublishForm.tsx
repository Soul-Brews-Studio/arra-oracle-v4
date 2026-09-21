import { type ReactNode, useState } from "react";
import { BODY_FORMATS, HORIZON_TERMS, TYPE_TERMS, type PublishInput, type TypeTerm, type HorizonTerm } from "../api/knowledge";

type Draft = Omit<PublishInput, "node_id" | "base_revision_id">;
/** Publish a new revision -- either a node's first one or an edit on top of
 *  its current head. `author_peer_name` / `session_name` are not exposed as
 *  fields: this UI has no logged-in identity concept yet, so they go over
 *  as `null` rather than invented. */
export function PublishForm({
  onPublish,
  publishing,
  disabled,
  disabledReason,
  editingNode,
}: {
  onPublish: (input: Draft) => void;
  publishing: boolean;
  disabled: boolean;
  disabledReason?: string;
  editingNode: boolean;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [bodyFormat, setBodyFormat] = useState<(typeof BODY_FORMATS)[number]>("text");
  const [typeTerm, setTypeTerm] = useState<TypeTerm>("note");
  const [horizon, setHorizon] = useState<HorizonTerm | "none">("none");
  const [changeReason, setChangeReason] = useState("");

  const canSubmit = !disabled && !publishing && title !== "" && body !== "";

  const submit = () => {
    if (!canSubmit) return;
    onPublish({
      title,
      body,
      body_format: bodyFormat,
      type_term: typeTerm,
      horizon: horizon === "none" ? null : horizon,
      change_reason: changeReason === "" ? null : changeReason,
      author_peer_name: null,
      session_name: null,
    });
    setTitle("");
    setBody("");
    setChangeReason("");
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      {disabled && disabledReason && <p className="text-xs text-muted">{disabledReason}</p>}
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="title…"
        className="rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="body…"
        rows={5}
        className="rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
      />
      <FieldRow label="format">
        <select value={bodyFormat} onChange={(e) => setBodyFormat(e.target.value as (typeof BODY_FORMATS)[number])}>
          {BODY_FORMATS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="type">
        <select value={typeTerm} onChange={(e) => setTypeTerm(e.target.value as TypeTerm)}>
          {TYPE_TERMS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="horizon">
        <select value={horizon} onChange={(e) => setHorizon(e.target.value as HorizonTerm | "none")}>
          <option value="none">none</option>
          {HORIZON_TERMS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </FieldRow>
      <input
        value={changeReason}
        onChange={(e) => setChangeReason(e.target.value)}
        placeholder="change reason (optional)…"
        className="rounded border border-edge bg-ink px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
      />
      <button
        onClick={submit}
        disabled={!canSubmit}
        className="rounded border border-accent/40 bg-accent/10 px-2 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-40"
      >
        {publishing ? "publishing…" : editingNode ? "publish revision" : "create node"}
      </button>
    </div>
  );
}

/** A label + select pair, factored out only so the three selects above
 *  don't repeat the same wrapper markup three times. */
function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-muted">
      <span className="uppercase tracking-wide">{label}</span>
      <span className="[&>select]:rounded [&>select]:border [&>select]:border-edge [&>select]:bg-ink [&>select]:px-2 [&>select]:py-1 [&>select]:text-xs [&>select]:text-slate-100">
        {children}
      </span>
    </label>
  );
}
