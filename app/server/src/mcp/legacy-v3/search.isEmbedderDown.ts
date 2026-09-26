/**
 * Whether a `searchKnowledgeSemantic` failure means "the query embedder did
 * not answer" -- the one case the v3 tools degrade on (keyword fallback in
 * `oracle_search`, a stop or a refusal in `oracle_search_chain`) instead of
 * failing.
 *
 * The kernel reports it as the governed `writer_unavailable` with an empty
 * path (`publication/service.embedSearchQuery.ts`: no embedder, a throw, a
 * timeout, a malformed vector). The search runs on the READER, which never
 * writes, so on this path that envelope has no other source; a path would
 * mean an argument fault, which is not the embedder's.
 */
export function isEmbedderDown(error: unknown): boolean {
  const e = error as { code?: unknown; path?: unknown; toJSON?: unknown } | null;
  return typeof e === "object" && e !== null && e.code === "writer_unavailable" && e.path === "" && typeof e.toJSON === "function";
}
