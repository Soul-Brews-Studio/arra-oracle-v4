import { type ReactNode, useState } from "react";
import { BODY_FORMATS, HORIZON_TERMS, TYPE_TERMS, type TypeTerm, type HorizonTerm } from "../api/knowledge";
import { buildLinkSnapshot } from "../state/buildLinkSnapshot";
import { buildPublishInput, type PublishDraft } from "../state/buildPublishInput";
import type { CiteTarget, LinkDraft } from "../state/linkDraft.types";
import { LinkEditor } from "./LinkEditor";

export type Draft = PublishDraft;

// Wording fix (2026-09-27): this is this FORM's own guard, not a server
// rule -- `rg` finds no correction/corrects enforcement in app/server/src.
// The old copy ("publish refuses...") read as if the server enforced it.
const CORRECTION_NEEDS_LINK =
  "type “correction” needs a corrects link below (pointing at the revision this corrects), " +
  "or use the Correct action instead -- this form will not submit a correction without one.";

/** Publish a new revision -- either a node's first one or an edit on top of
 *  its current head. `author_peer_name` / `session_name` are not exposed as
 *  fields: this UI has no logged-in identity concept yet, so they go over
 *  as `null` rather than invented.
 *
 * `initialTitle` / `initialBody` / `initialLinks` / `submitRef` exist ONLY
 * for tests: this repo's render tests are `react-dom/server` + no jsdom
 * (deliberately no DOM dependency), so there is no way to type into a field
 * or click a button from outside. These seams let a test fill the form and
 * invoke `submit()` directly and read what reaches `onPublish` -- see
 * `buildPublishInput.test.ts` and `citeCorrect.test.ts`, both of which pin
 * wiring that byte-for-bytes HTML assertions cannot reach. */
export function PublishForm({
  onPublish,
  publishing,
  disabled,
  disabledReason,
  editingNode,
  citeTargets = [],
  initialTitle = "",
  initialBody = "",
  initialLinks = [],
  initialTypeTerm = "note",
  submitRef,
}: {
  onPublish: (input: Draft) => void;
  publishing: boolean;
  disabled: boolean;
  disabledReason?: string;
  editingNode: boolean;
  /** #33 cite: loaded revisions the link editor offers as picks. */
  citeTargets?: CiteTarget[];
  /** Test-only seams -- see the doc comment above. */
  initialTitle?: string;
  initialBody?: string;
  initialLinks?: LinkDraft[];
  initialTypeTerm?: TypeTerm;
  submitRef?: { current: (() => void) | null };
}) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [bodyFormat, setBodyFormat] = useState<(typeof BODY_FORMATS)[number]>("text");
  const [typeTerm, setTypeTerm] = useState<TypeTerm>(initialTypeTerm);
  const [horizon, setHorizon] = useState<HorizonTerm | "none">("none");
  const [changeReason, setChangeReason] = useState("");
  const [links, setLinks] = useState<LinkDraft[]>(initialLinks);
  const built = buildLinkSnapshot(links);

  // #33 TODO4 hardening: the generic form must not let `type: correction`
  // through without the `corrects` link that makes it one -- that link is
  // what the distinct Correct action (CorrectForm) exists to guarantee.
  const hasCorrectsLink = built.ok && built.entries.some((e) => e.relation === "corrects");
  const correctionMissingLink = typeTerm === "correction" && !hasCorrectsLink;

  const canSubmit = !disabled && !publishing && title !== "" && body !== "" && built.ok && !correctionMissingLink;

  const submit = () => {
    if (!canSubmit || !built.ok) return;
    onPublish(
      buildPublishInput({ title, body, bodyFormat, typeTerm, horizon, changeReason }, built.entries),
    );
    setTitle("");
    setBody("");
    setChangeReason("");
    setLinks([]);
  };
  if (submitRef) submitRef.current = submit;

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
      {correctionMissingLink && <p className="text-xs text-rose-300">{CORRECTION_NEEDS_LINK}</p>}
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
      <LinkEditor drafts={links} onChange={setLinks} citeTargets={citeTargets} />
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
