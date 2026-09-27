import { useState } from "react";
import type { ChatAnswer } from "../api/memory";
import { ChatError } from "./ChatError";
import { CoverageBadge } from "./CoverageBadge";
import { ExcludedList } from "./ExcludedList";
import { ModelNote } from "./ModelNote";

const DEFAULT_MAX_ITEMS = 20;

/**
 * The Honcho "dialectic" equivalent: ask a question as a peer, about a
 * session, and see both the answer and exactly the evidence it was allowed
 * to use. Presentational -- the parent owns the `answerChat` call and the
 * peer/session selection that scopes it.
 */
export function DialecticPanel({
  onAsk,
  answer,
  asking,
  error,
  disabled,
  disabledReason,
}: {
  onAsk: (question: string, maxItems: number) => void;
  answer: ChatAnswer | null;
  asking: boolean;
  error: string | null;
  disabled: boolean;
  disabledReason: string | null;
}) {
  const [question, setQuestion] = useState("");
  const [maxItems, setMaxItems] = useState(DEFAULT_MAX_ITEMS);

  const submit = () => {
    if (!question.trim() || asking || disabled) return;
    onAsk(question.trim(), maxItems);
  };

  return (
    <section className="flex flex-col gap-3 border-b border-edge p-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Ask as peer</h2>

      {disabled && disabledReason && (
        <p className="text-[11px] text-[#f0a35e]">{disabledReason}</p>
      )}

      <textarea
        className="min-h-16 resize-none rounded border border-edge bg-ink px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent disabled:opacity-50"
        placeholder="What does this peer know about..."
        aria-label="Question to ask as this peer"
        value={question}
        disabled={disabled}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-[11px] text-muted">
          max_items
          <input
            type="number"
            min={1}
            max={50}
            value={maxItems}
            disabled={disabled}
            onChange={(e) => setMaxItems(Number(e.target.value))}
            className="w-16 rounded border border-edge bg-ink px-2 py-1 text-slate-100 outline-none focus:border-accent disabled:opacity-50"
          />
        </label>
        <button
          onClick={submit}
          disabled={disabled || asking || !question.trim()}
          className="ml-auto rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {asking ? "Asking..." : "Ask"}
        </button>
      </div>

      <ChatError code={error} />

      {answer && (
        <div className="flex flex-col gap-3 rounded border border-edge bg-panel p-3">
          <p className="whitespace-pre-wrap text-sm text-slate-100">{answer.answer}</p>
          <CoverageBadge coverage={answer.coverage} />
          <ExcludedList excluded={answer.excluded} omitted={answer.excluded_omitted} />
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
              items_used ({answer.items_used.length})
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {answer.items_used.map((id) => (
                <li key={id} className="truncate font-mono text-[11px] text-muted">
                  {id}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <ModelNote />
    </section>
  );
}
