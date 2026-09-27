import { type ApiResult } from "./client";
import { type Page } from "./listing";
import { asError } from "./memory";

/** True when the endpoint ITSELF is absent, as opposed to the request being
 *  bad. Two shapes, and the second was found by measurement rather than by
 *  reading the contract:
 *
 *    - a `method_not_found` envelope, which is what the documented refusal
 *      looks like
 *    - a bare HTTP 404. An unregistered knowledge method is rejected by the
 *      transport BEFORE any kernel runs, so it never reaches the code that
 *      builds an `arra-error/v1` envelope. Measured against a server without
 *      these methods: `POST /api/knowledge/default/listPeers` answers
 *      `404` with the body `{"error":"error"}` -- no code, nothing to match.
 *
 *  Treating only the first shape as unsupported is exactly the false-empty
 *  this function exists to prevent: the UI would render "no peers" over a
 *  server that has no way to tell you whether there are any.
 *
 *  404 is safe to read this way here because every method in this module is
 *  a LISTING call, and a listing has no row-level identity that could be
 *  legitimately not-found. A 404 from these three can only mean the route. */
function isUnsupported(result: ApiResult): boolean {
  if (asError(result.body)?.code === "method_not_found") return true;
  return result.status === 404;
}

export function toPage<T>(result: ApiResult, cursorKey: string): Page<T> {
  if (!result.ok) {
    const unsupported = isUnsupported(result);
    return {
      rows: [],
      nextCursor: null,
      total: null,
      supported: !unsupported,
      // `result.error` is a thrown-fetch (transport) message; prefer it,
      // then the governed envelope code, then the bare status -- the same
      // fallback order `describe()` uses in `useMemory.ts`/`useKnowledge.ts`.
      error: unsupported ? null : (result.error ?? asError(result.body)?.code ?? `HTTP ${result.status}`),
    };
  }
  // A 2xx whose body is not an object (`null`, a bare value) is a malformed
  // answer, not an empty listing: say so rather than throw (ui-reads2 -- the
  // throw skipped the caller's land() and latched "loading") or show zero.
  if (result.body === null || typeof result.body !== "object") {
    return { rows: [], nextCursor: null, total: null, supported: true, error: "malformed listing response (no body)" };
  }
  const body = result.body as Record<string, unknown>;
  const rows = Array.isArray(body.rows) ? (body.rows as T[]) : [];
  const nextCursor = typeof body[cursorKey] === "string" ? (body[cursorKey] as string) : null;
  const total = typeof body.total === "string" ? body.total : null;
  return { rows, nextCursor, total, supported: true, error: null };
}
