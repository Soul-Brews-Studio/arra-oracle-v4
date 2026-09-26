/** Failing-first tests for `chatError` (#33 peer chat: "a clear
 *  model_unavailable state"). Pure, no DOM: `bun test src/state/chatError.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { chatError } from "./chatError";

describe("chatError", () => {
  test("null reads as no error", () => {
    expect(chatError(null)).toBeNull();
  });

  test("model_unavailable (#32 / R9) is its own distinct kind, not a generic failure", () => {
    const view = chatError("model_unavailable");
    expect(view).not.toBeNull();
    expect(view!.kind).toBe("model_unavailable");
    expect(view!.title).toMatch(/model/i);
    expect(view!.detail).toMatch(/getContext/);
  });

  test("any other GOVERNED code reads as a generic chat failure, verbatim", () => {
    const view = chatError("forbidden");
    expect(view).not.toBeNull();
    expect(view!.kind).toBe("failed");
    expect(view!.title).toBe("forbidden");
  });

  // Fix-round finding (nonblocking): `useMemory`'s `describe()` returns
  // `result.error` verbatim for a TRANSPORT failure (a thrown fetch
  // exception, e.g. "Failed to fetch"/"Load failed"/"NetworkError..."),
  // which never reached the server at all -- "The server refused this
  // question" was misleading for exactly that case.
  test("a transport failure (never reached the server) reads distinctly from a governed refusal", () => {
    const view = chatError("Failed to fetch");
    expect(view).not.toBeNull();
    expect(view!.kind).toBe("failed");
    expect(view!.title).not.toBe("Failed to fetch");
    expect(view!.title).toMatch(/reach/i);
    expect(view!.detail).toMatch(/Failed to fetch/);
  });

  // `describe()`'s third shape -- `HTTP ${status}` for a response with no
  // recognized envelope -- DID reach the server, so it must not be folded
  // into the transport-failure wording either.
  test("an HTTP-status-only code (no envelope) still reads as a server response, not a transport failure", () => {
    const view = chatError("HTTP 500");
    expect(view).not.toBeNull();
    expect(view!.title).toBe("HTTP 500");
  });

  // Fix-round 2 finding (nonblocking): `describe()` also has a FOURTH shape,
  // `${code} at ${pointer}`, for a governed error that names the refused field.
  // It reached the server, but `reachedServer` required a bare snake_case code,
  // so the space made it read "Could not reach the server ... check your
  // connection". Latent today only because `asError` reads `pointer` while the
  // server sends `path`; it breaks the moment that is corrected.
  test("a governed code with a pointer (`code at /field`) reads as a server refusal, not a transport failure", () => {
    const view = chatError("invalid_value at /max_items");
    expect(view).not.toBeNull();
    expect(view!.kind).toBe("failed");
    expect(view!.title).toBe("invalid_value at /max_items");
    expect(view!.title).not.toMatch(/reach/i);
    expect(view!.detail).not.toMatch(/connection/i);
  });

  test("model_unavailable with a pointer is still the model_unavailable state", () => {
    const view = chatError("model_unavailable at /question");
    expect(view!.kind).toBe("model_unavailable");
  });

  test("free-form transport prose that happens to contain ' at ' is still a transport failure", () => {
    const view = chatError("NetworkError when attempting to fetch resource.");
    expect(view!.title).toMatch(/reach/i);
    expect(chatError("Load failed at startup")!.title).toMatch(/reach/i);
  });
});
