/**
 * #32 evidence-grounded chat kernel -- smoke test.
 *
 * Not exhaustive: this proves the load-bearing properties the issue asks
 * for, the same way `mcp-correctness.test.ts` proves "no model I/O" with a
 * fail-if-used stub rather than a full contract suite. Persistence cases run
 * through a real gated writer, exactly like every other #28/#32 kernel slice
 * in this directory -- a mocked store would only prove the mock agrees with
 * itself.
 *
 * Proven here:
 *   1. `getContext` performs NO model call (a counting stub that must stay
 *      at zero through the entire read-only path).
 *   2. Per-item authorization refuses an unauthorized item BEFORE
 *      composition: a linked session's message from a peer the requester is
 *      not a member of never reaches `items`, `answer` or the model's own
 *      input.
 *   3. Partial coverage is reported STRUCTURALLY (a `coverage: "partial"`
 *      field plus an `excluded` entry), never a silent truncation.
 *   4. Both governed envelope families still work for chat's own grammar and
 *      stored-state failures.
 */

import { describe, expect, test } from "bun:test";
import { ContractError } from "../src/contracts/errors";
import { parseAnswerChat, parseGetContext } from "../src/publication/chat";
import { createContextFixture } from "./helpers/context-fixture";
import { runGated } from "./helpers/publication-fixture";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("chat request grammar is closed, and keeps the GOVERNED envelope", () => {
  test("parseGetContext and parseAnswerChat parse their exact shapes", () => {
    const getContextReq = { workspace_name: "w", peer_name: "p", session_name: "s", max_items: 5 };
    expect(parseGetContext(bytes(getContextReq))).toEqual(getContextReq);
    const answerReq = { ...getContextReq, question: "what happened?" };
    expect(parseAnswerChat(bytes(answerReq))).toEqual(answerReq);
  });

  test("an unexpected field is a governed ContractError, not a publication envelope", () => {
    expect(() =>
      parseGetContext(bytes({ workspace_name: "w", peer_name: "p", session_name: "s", max_items: 5, extra: 1 })),
    ).toThrow(ContractError);
    try {
      parseGetContext(bytes({ workspace_name: "w", peer_name: "p", session_name: "s", max_items: 5, extra: 1 }));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).toJSON().version).toBe("arra-error/v1");
      expect((error as ContractError).code).toBe("unexpected_field");
    }
  });

  test("max_items out of 1..50 is a governed invalid_value, and question must be nonempty", () => {
    const base = { workspace_name: "w", peer_name: "p", session_name: "s" };
    expect(() => parseGetContext(bytes({ ...base, max_items: 0 }))).toThrow(ContractError);
    expect(() => parseGetContext(bytes({ ...base, max_items: 51 }))).toThrow(ContractError);
    expect(() => parseAnswerChat(bytes({ ...base, max_items: 5, question: "" }))).toThrow(ContractError);
  });
});

describe("real persistence: getContext and answerChat inside the real gate", () => {
    const CHILD = new URL("./fixtures/chat-v1/gated-chat.ts", import.meta.url).pathname;
    const TIMEOUT_MS = 180_000;

    const drive = async (payload: Record<string, unknown>) => {
      const fixture = await createContextFixture(["alpha-workspace"]);
      try {
        const run = await runGated(fixture.datasetRoot, CHILD, [
          fixture.datasetRoot,
          JSON.stringify(payload),
        ]);
        const line = run.stdout.trim().split("\n").pop();
        if (line === undefined) throw new Error(`no output: ${run.stderr.slice(0, 800)}`);
        return JSON.parse(line);
      } finally {
        await fixture.cleanup();
      }
    };

    test(
      "getContext excludes an unauthorized candidate BEFORE composition, and never calls the model",
      async () => {
        const parsed = await drive({
          modelMode: "ok",
          getContextArgs: {
            workspace_name: "alpha-workspace",
            peer_name: "peer-a",
            session_name: "session-main",
            max_items: 10,
          },
        });

        expect(parsed.getContext.ok).toBe(true);
        const result = parsed.getContext.value;
        // Both authorized messages come back; the linked session's message
        // from a peer the requester never joined does not.
        const ids = result.items.map((item: { public_id: string }) => item.public_id).sort();
        expect(ids).toEqual([parsed.visibleId, parsed.visibleId2].sort());
        expect(result.items.some((item: { content: string }) => item.content.includes("secret"))).toBe(false);
        expect(result.coverage).toBe("full");
        expect(result.excluded).toContainEqual({
          reason: "unauthorized",
          session_name: "session-other",
          public_id: parsed.secretId,
        });
        // NO model call anywhere on this path.
        expect(parsed.modelCallsAfterGetContext).toBe(0);

        // The publication envelope still guards chat's own stored-state
        // reference failures: a session this workspace never registered.
        expect(parsed.absentSession.ok).toBe(false);
        expect(parsed.absentSession).toMatchObject({
          name: "PublicationError",
          code: "invalid_reference",
          path: "/session_name",
          version: "arra-publication-error/v1",
        });
      },
      TIMEOUT_MS,
    );

    test(
      "partial coverage is reported structurally, and the model never sees the excluded item's content",
      async () => {
        const parsed = await drive({
          modelMode: "ok",
          getContextArgs: {
            workspace_name: "alpha-workspace",
            peer_name: "peer-a",
            session_name: "session-main",
            // Only ONE of the two authorized messages fits: this must be
            // reported, never silently dropped.
            max_items: 1,
          },
          answerChatArgs: {
            workspace_name: "alpha-workspace",
            peer_name: "peer-a",
            session_name: "session-main",
            question: "what happened?",
            max_items: 1,
          },
        });

        const result = parsed.getContext.value;
        expect(result.items.length).toBe(1);
        expect(result.coverage).toBe("partial");
        expect(
          result.excluded.some(
            (e: { reason: string; session_name: string }) =>
              e.reason === "budget_exceeded" && e.session_name === "session-main",
          ),
        ).toBe(true);
        // The unauthorized candidate is STILL reported, distinctly.
        expect(
          result.excluded.some((e: { reason: string; session_name: string }) => e.reason === "unauthorized"),
        ).toBe(true);

        // answerChat composed from the SAME authorized, budget-capped set:
        // the model call happened exactly once, after getContext's own
        // model-free pass.
        expect(parsed.answerChat.ok).toBe(true);
        expect(parsed.modelCallsAfterGetContext).toBe(0);
        expect(parsed.modelCallsAfterAnswer).toBe(1);
        expect(parsed.answerChat.value.answer).toBe("stub answer");
        expect(parsed.answerChat.value.coverage).toBe("partial");
        expect(parsed.answerChat.value.items_used.length).toBe(1);

        // The excluded item's content never reached the model's own input,
        // in any form -- not the rendered text, not the raw items array.
        const modelInputText = JSON.stringify(parsed.lastModelInput);
        expect(modelInputText.includes("secret unauthorized message")).toBe(false);
      },
      TIMEOUT_MS,
    );

    test(
      "a model failure maps onto the closed publication code set, never a third envelope",
      async () => {
        const parsed = await drive({
          modelMode: "fail",
          getContextArgs: {
            workspace_name: "alpha-workspace",
            peer_name: "peer-a",
            session_name: "session-main",
            max_items: 10,
          },
          answerChatArgs: {
            workspace_name: "alpha-workspace",
            peer_name: "peer-a",
            session_name: "session-main",
            question: "what happened?",
            max_items: 10,
          },
        });

        expect(parsed.answerChat.ok).toBe(false);
        expect(parsed.answerChat).toMatchObject({
          name: "PublicationError",
          code: "writer_unavailable",
          path: "",
          version: "arra-publication-error/v1",
        });
      },
      TIMEOUT_MS,
    );
});
