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

  test("any other code reads as a generic chat failure, verbatim", () => {
    const view = chatError("forbidden");
    expect(view).not.toBeNull();
    expect(view!.kind).toBe("failed");
    expect(view!.title).toBe("forbidden");
  });
});
