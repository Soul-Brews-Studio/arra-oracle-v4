/** Pure state/error mapping for the knowledge search box (#33, R7/R21).
 *
 * `useKnowledgeSearch` hands this the raw shape of "what happened", and this
 * file is the only place that decides which of the five states the brief
 * names is showing: empty query, loading, no results, index_unavailable (the
 * FTS index has never been built by `indexRevisionChunks` -- keyword search
 * still answers via the scan fallback, so this is a NOTE on a normal
 * response, not an error) and model_unavailable (semantic with no embedder,
 * or one that failed -- overnight R9/R21, same closed code chat uses).
 *
 * `errorCode` is the bare governed code (`asError(...).code`), not a full
 * envelope -- the same shape `chatError.ts` already normalizes on, so this
 * file stays a plain string match instead of a second HTTP-parsing pass.
 */
export type SearchStateView =
  | { kind: "empty_query" }
  | { kind: "loading" }
  | { kind: "model_unavailable"; detail: string }
  | { kind: "error"; title: string; detail: string }
  | { kind: "no_results"; scanNote: string | null }
  | { kind: "results"; scanNote: string | null };

const MODEL_UNAVAILABLE_DETAIL =
  "No embedder is configured, or it did not answer. Semantic search needs a local " +
  "model server (Ollama) running and reachable; keyword search does not need one.";

function scanNoteFor(scanReason: "short_query" | "index_unavailable" | null): string | null {
  if (scanReason === "short_query") {
    return "Query is short: used a plain substring scan instead of the trigram index.";
  }
  if (scanReason === "index_unavailable") {
    return "The keyword index has not been built yet (run indexRevisionChunks first): " +
      "showing a slower substring scan instead.";
  }
  return null;
}

export function searchState(input: {
  query: string;
  loading: boolean;
  errorCode: string | null;
  hitCount: number;
  scanReason: "short_query" | "index_unavailable" | null;
}): SearchStateView {
  if (input.query.trim() === "") return { kind: "empty_query" };
  if (input.loading) return { kind: "loading" };
  if (input.errorCode !== null) {
    if (input.errorCode === "model_unavailable" || input.errorCode.startsWith("model_unavailable ")) {
      return { kind: "model_unavailable", detail: MODEL_UNAVAILABLE_DETAIL };
    }
    return { kind: "error", title: input.errorCode, detail: "The server refused this search; see the code above." };
  }
  const scanNote = scanNoteFor(input.scanReason);
  if (input.hitCount === 0) return { kind: "no_results", scanNote };
  return { kind: "results", scanNote };
}
