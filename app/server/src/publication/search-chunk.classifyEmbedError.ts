/**
 * The closed `error_code` set `embedPendingChunks` writes on a `failed`
 * transition. Not a stored enum -- `error_code` is `utf8`, NULLABLE -- this
 * closed set is this module's own decision, matching `storedStatus`'s
 * comment about `status` for the same column family.
 */
export const EMBED_ERROR_CODES = [
  "embedder_unavailable",
  "embedder_timeout",
  "embedder_bad_response",
] as const;

export type EmbedErrorCode = (typeof EMBED_ERROR_CODES)[number];

/** Thrown by `embedPendingChunks` itself to force its own `Promise.race`
 *  timeout branch, distinguished from any error the embedder throws. */
export class EmbedTimeoutError extends Error {}

/**
 * Classify whatever the injected embedder call rejected with (or, absent an
 * embedder entirely, a `no embedder configured` sentinel) into the closed
 * set above. `embedder_timeout` is reserved for the caller's OWN race,
 * never guessed from an error's message text -- an `AbortError` the
 * embedder throws on its own initiative (not from the injected signal)
 * still classifies as `embedder_bad_response`, since this function cannot
 * tell the two apart from the error alone and a false "timeout" would be a
 * more specific claim than is actually known.
 */
export function classifyEmbedError(error: unknown): EmbedErrorCode {
  if (error instanceof EmbedTimeoutError) return "embedder_timeout";
  return "embedder_bad_response";
}
