import { type ErrorEnvelope } from "./memory";

/** The server's error envelope, `arra-error/v1` and its two siblings. Shown
 *  verbatim rather than flattened to a string: the `code` is the part worth
 *  reading, and `pointer` says exactly which field was refused. */
export function asError(body: unknown): ErrorEnvelope | null {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;
  // The Host/Origin/bearer gate every transport shares (`auth/http.ts`'s
  // `ERROR_BODIES`, e.g. `{"error":"unauthenticated"}` / `{"error":"forbidden"}`)
  // answers BEFORE a request ever reaches an `arra-error/v1` envelope, and its
  // body is a bare STRING under `error`, not `{code,...}`. Without this branch
  // that string fell into the object-shape check below, found no `.code`, and
  // returned null -- so a live 401/403 from THIS gate read as the generic
  // `HTTP ${status}` fallback in `describe()` instead of its real reason.
  //
  // Fix-round finding: this used to decode EVERY `{error: string}` shape, not
  // just the auth gate's two codes. `ERROR_BODIES` also answers 400 ("bad
  // request"), 413 ("payload too large"), 415 ("unsupported media type") and
  // 503 ("policy unavailable") this same flat way, and an unregistered route's
  // bare 404 falls back to `{"error":"error"}`. Decoding those as governed
  // codes fed `chatError.ts`'s GOVERNED regex a spaced string it cannot match
  // ("bad request"), which made it misclassify a real 400 as a transport
  // failure that "never reached the server" -- false, since the server
  // answered. Restricting this branch to the two identifiers `authErrorHint`
  // actually knows how to explain lets every other flat body fall through to
  // the object-shape check below (finds no `.code`, returns null), so
  // `describe()` reports `HTTP 400`/`413`/`415`/`503`/`404` instead -- a
  // bare status string `chatError`'s `reachedServer` already recognizes
  // correctly, and the same fallback this codebase used before #33.
  if (o.error === "unauthenticated" || o.error === "forbidden") return { code: o.error };
  const err = (o.error ?? o) as Record<string, unknown>;
  if (typeof err !== "object" || err === null) return null;
  const code = typeof err.code === "string" ? err.code : undefined;
  if (code === undefined) return null;
  return {
    code,
    pointer: typeof err.pointer === "string" ? err.pointer : undefined,
    message: typeof err.message === "string" ? err.message : undefined,
  };
}
