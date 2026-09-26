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
 */
export type ChatErrorView = {
  kind: "model_unavailable" | "failed";
  title: string;
  detail: string;
};

const MODEL_UNAVAILABLE_DETAIL =
  "No chat model is configured, or it did not answer (unreachable, timed out, or failed). " +
  "Nothing was read wrongly and nothing broke: getContext above has no model dependency and should still work.";

export function chatError(code: string | null): ChatErrorView | null {
  if (code === null) return null;
  if (code === "model_unavailable") {
    return { kind: "model_unavailable", title: "Model unavailable", detail: MODEL_UNAVAILABLE_DETAIL };
  }
  return { kind: "failed", title: code, detail: "The server refused this question; see the code above." };
}
