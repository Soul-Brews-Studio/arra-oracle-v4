import { useState } from "react";
import type { TaxonomyIds } from "../api/knowledge";

/** The seeding panel. This is the one place in the UI that has to say, in
 *  plain language, that `TaxonomyIds` is the only copy of the vocabulary/term
 *  ids that exists ANYWHERE this client can reach -- `getVocabulary` and
 *  `getTerm` take ids, not names, and there is no lookup from "type" back to
 *  an id (see knowledge.ts). Losing this object before it is written down
 *  somewhere durable means the seeded vocabularies become unreachable by this
 *  client, even though they still exist server-side. That is a real
 *  consequence, so it gets a paragraph, not a tooltip. */
export function TaxonomySetup({
  ids,
  seeded,
  onSeed,
  busy,
  error,
}: {
  ids: TaxonomyIds | null;
  seeded: boolean;
  onSeed: () => void;
  busy: boolean;
  error: string | null;
}) {
  if (!seeded || ids === null) {
    return (
      <div className="flex flex-col gap-3 rounded border border-edge bg-panel p-4">
        <div>
          <p className="text-sm font-medium text-slate-100">Reserved vocabularies not seeded</p>
          <p className="mt-1 text-xs text-muted">
            Every revision needs exactly one `type` term, and this workspace has no vocabulary/term ids
            for `type` or `memory_horizon` yet. Seeding mints them CLIENT-side and holds them only in
            this browser -- there is no server lookup from a name like "type" back to its id. Write
            the minted ids down somewhere durable once you have them; if this browser's storage is
            lost before that, the seeded vocabularies become unreachable by any client, even though
            the data still exists on the server.
          </p>
        </div>
        {error && (
          <p className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200/80">
            {error}
          </p>
        )}
        <button
          onClick={onSeed}
          disabled={busy}
          className="self-start rounded border border-accent/40 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
        >
          {busy ? "seeding…" : "seed reserved vocabularies"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200/80">
          {error}
        </p>
      )}
      <VocabularyBlock label="type" vocabularyId={ids.type.vocabulary_id} terms={ids.type.terms} />
      <VocabularyBlock
        label="memory_horizon"
        vocabularyId={ids.memory_horizon.vocabulary_id}
        terms={ids.memory_horizon.terms}
      />
    </div>
  );
}

/** Name first, id second.
 *
 * The first version of this laid out `name ......... [id]` with
 * `justify-between`, which put a 21-character nanoid at the right edge of a
 * narrow panel and the human-readable name at the far left. The result was a
 * column of `ZXZgaq...p5mA` with nothing legible next to it -- the id, which
 * a human never needs to read, dominated the thing a human always needs to
 * read.
 *
 * The id still has to be here (it is held nowhere else, and losing it makes
 * the vocabulary unreachable), but it belongs UNDER the name as secondary
 * text, not beside it competing for the same line.
 */
function VocabularyBlock({
  label,
  vocabularyId,
  terms,
}: {
  label: string;
  vocabularyId: string;
  terms: Record<string, string>;
}) {
  return (
    <div className="rounded border border-edge bg-panel p-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold text-slate-100">{label}</span>
        <CopyId id={vocabularyId} hint="vocabulary id" />
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {Object.entries(terms).map(([term, termId]) => (
          <li key={term} className="flex flex-col gap-0.5 border-l-2 border-edge pl-2">
            <span className="text-xs text-slate-200">{term}</span>
            <CopyId id={termId} hint={`term id for ${term}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Truncated id + copy button. Copying is the whole point -- this id is held
 *  nowhere else, so making it easy to paste into a durable note is not a
 *  nicety here, it's the mitigation for the loss described above. */
function CopyId({ id, hint }: { id: string; hint: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={`${hint} — click to copy\n${id}`}
      className="self-start rounded px-0 py-0 text-left font-mono text-[10px] text-muted hover:text-accent"
    >
      {copied ? "copied ✓" : `${id.slice(0, 6)}…${id.slice(-4)}`}
    </button>
  );
}
