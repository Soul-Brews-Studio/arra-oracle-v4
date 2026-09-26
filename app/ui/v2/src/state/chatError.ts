/** The pure mapping behind the peer chat surface's error state (#33, #32 /
 *  overnight ruling R9): "a clear model_unavailable state".
 *
 * `useMemory`'s `askError` is already the bare error CODE by the time it
 * reaches here (`describe()` drops the pointer for a root-path publication
 * error, and `model_unavailable` always has one -- see `chat.ts`'s
 * `mapModelFailure`), so a plain string match is enough: no second network
 * round trip, no guessing from the message text.
 *
 * `model_unavailable` gets its OWN kind because it means something a caller
 * can act on differently from any other failure: nothing was read wrongly
 * and nothing broke, there is simply no model configured or reachable right
 * now -- `getContext` above still works, so evidence retrieval is not
 * blocked, only the one extra step of having a model phrase an answer over
 * it. Rendering it as the same red text as `forbidden` or a network error
 * would erase exactly that distinction.
 *
 * Fix-round finding (nonblocking): `describe()` (in `useMemory.ts`) can hand
 * this THREE different shapes of string, and the previous version of this
 * file treated them all alike:
 *   - a GOVERNED error code from the server's own envelope (e.g.
 *     `"forbidden"`, `"model_unavailable"`) -- the request reached the
 *     server, which refused it. Snake_case, lowercase, no spaces.
 *   - `"HTTP ${status}"` -- the request also reached the server, but the
 *     response carried no recognized envelope.
 *   - `result.error` verbatim for a TRANSPORT failure -- a thrown `fetch`
 *     exception (Chrome: "Failed to fetch"; Firefox: "NetworkError when
 *     attempting to fetch resource."; Safari: "Load failed") -- which never
 *     reached the server at all. "The server refused this question" is
 *     false for this case, not just imprecise.
 */
export type ChatErrorView = {
  kind: "model_unavailable" | "failed";
  title: string;
  detail: string;
};

const MODEL_UNAVAILABLE_DETAIL =
  "No chat model is configured, or it did not answer (unreachable, timed out, or failed). " +
  "Nothing was read wrongly and nothing broke: getContext above has no model dependency and should still work.";

/** A governed error code, optionally with the pointer `describe()` appends
 *  (`invalid_value at /max_items`). Fix-round 2 finding: the pointer form has
 *  a space, and the previous bare-snake_case test read it as a transport
 *  failure ("check your connection") although the server answered it. */
const GOVERNED = /^([a-z][a-z0-9_]*)(?: at \/\S*)?$/;

/** A governed code (with or without a pointer) or the `HTTP ${status}`
 *  fallback -- both mean the request reached the server. Anything else is
 *  `describe()`'s transport shape: a raw exception message, which never
 *  matches either pattern (it is free-form prose, not a snake_case
 *  identifier, an identifier plus a `/`-pointer, or a bare status line). */
function reachedServer(code: string): boolean {
  return GOVERNED.test(code) || /^HTTP \d+$/.test(code);
}

export function chatError(code: string | null): ChatErrorView | null {
  if (code === null) return null;
  if (GOVERNED.exec(code)?.[1] === "model_unavailable") {
    return { kind: "model_unavailable", title: "Model unavailable", detail: MODEL_UNAVAILABLE_DETAIL };
  }
  if (!reachedServer(code)) {
    return {
      kind: "failed",
      title: "Could not reach the server",
      detail: `The request did not complete: ${code}. Check your connection and try again.`,
    };
  }
  return { kind: "failed", title: code, detail: "The server refused this question; see the code above." };
}
