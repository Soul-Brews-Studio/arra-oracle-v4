/**
 * Whether a `searchKnowledgeSemantic` failure means "the query embedder did
 * not answer" -- the one case the v3 tools degrade on (keyword fallback in
 * `oracle_search`, a stop or a refusal in `oracle_search_chain`) instead of
 * failing.
 *
 * The kernel reports it as the governed `model_unavailable` with an empty
 * path (`publication/service.embedSearchQuery.ts`: no embedder, a throw, a
 * timeout, a malformed vector; overnight R21, the same code chat answers
 * under R9). Before R21 it was `writer_unavailable`; that code no longer
 * means "no embedder" on this path, so it is not accepted here -- a reader
 * that somehow answered it would be a real fault, never a fallback. A path
 * would mean an argument fault, which is not the embedder's either.
 */
export function isEmbedderDown(error: unknown): boolean {
  const e = error as { code?: unknown; path?: unknown; toJSON?: unknown } | null;
  return typeof e === "object" && e !== null && e.code === "model_unavailable" && e.path === "" && typeof e.toJSON === "function";
}
