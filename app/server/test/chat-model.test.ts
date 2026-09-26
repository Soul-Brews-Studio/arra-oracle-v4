/**
 * #32 slice B (overnight ruling R9, docs/overnight/DECISIONS.md): the chat
 * model provider, built from env the way `readConfig` builds the runtime
 * config -- validated once, at startup, failing closed.
 *
 *   - ARRA_CHAT_PROVIDER unset => unconfigured (no model, settings null).
 *   - `ollama` is the one implemented provider: ARRA_CHAT_MODEL defaults to
 *     gemma3:4b, ARRA_CHAT_URL to the local Ollama; 512 output tokens and a
 *     60 s timeout are pinned, not configurable.
 *   - `anthropic` and `openai` are named interface slots that fail closed as
 *     unconfigured until Nat picks one and a credential path.
 *   - Anything else, or a malformed URL/model name, refuses startup.
 *
 * The Ollama call is exercised against a recording stub on 127.0.0.1 only.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createChatModel, createOllamaChatModel, readChatConfig, renderChatPrompt } from "../src/chat-model";
import type { ChatContextItem } from "../src/publication/chat";
import { startChatModelStub } from "./helpers/chat-model-stub";
import { testTimeout } from "./helpers/timing.testTimeout";
import { scaledMs } from "./helpers/timing.scaledMs";

const stub = startChatModelStub("ok");
// The "hang" test leaves one request open until the client aborts it. That
// used to make `stop()` wait for an event-loop wakeup that an afterAll never
// gets: it outlasted 5 s once locally and 30 s on the GitHub runner (run
// 36268048901). R13: the stub now settles what it holds before stopping
// (harness-chat-model-stub.test.ts); the bound stays, scaled, for the hook.
afterAll(() => stub.stop(), testTimeout(30_000));

const item = (public_id: string, content: string, session_name = "main", peer_name = "peer-a"): ChatContextItem => ({
  public_id,
  session_name,
  peer_name,
  role: null,
  content,
  seq_in_session: "1",
  created_at: "2026-09-26T00:00:00.000Z",
});
const ID = "evidenceid00000000001";

describe("readChatConfig: validated like readConfig", () => {
  test("no provider => unconfigured", () => {
    expect(readChatConfig({})).toEqual({ provider: null });
    expect(readChatConfig({ ARRA_CHAT_PROVIDER: "" })).toEqual({ provider: null });
  });

  test("ollama: gemma3:4b on the local Ollama, 512 tokens, 60 s -- the R9 pins", () => {
    expect(readChatConfig({ ARRA_CHAT_PROVIDER: "ollama" })).toEqual({
      provider: "ollama",
      model: "gemma3:4b",
      url: "http://127.0.0.1:11434",
      max_output_tokens: 512,
      timeout_ms: 60000,
    });
  });

  test("ARRA_CHAT_URL wins; otherwise the embedder's OLLAMA_URL names the same local Ollama", () => {
    expect(readChatConfig({ ARRA_CHAT_PROVIDER: "ollama", OLLAMA_URL: "http://127.0.0.1:9000" })).toMatchObject({
      url: "http://127.0.0.1:9000",
    });
    expect(
      readChatConfig({ ARRA_CHAT_PROVIDER: "ollama", OLLAMA_URL: "http://127.0.0.1:9000", ARRA_CHAT_URL: "http://127.0.0.1:9001/" }),
    ).toMatchObject({ url: "http://127.0.0.1:9001" });
  });

  test("ARRA_CHAT_MODEL overrides the model name", () => {
    expect(readChatConfig({ ARRA_CHAT_PROVIDER: "ollama", ARRA_CHAT_MODEL: "qwen2.5:3b" })).toMatchObject({ model: "qwen2.5:3b" });
  });

  test("anthropic and openai are named slots that fail closed as unconfigured", () => {
    expect(readChatConfig({ ARRA_CHAT_PROVIDER: "anthropic" })).toEqual({ provider: "anthropic" });
    expect(readChatConfig({ ARRA_CHAT_PROVIDER: "openai" })).toEqual({ provider: "openai" });
  });

  test("an unknown provider, a malformed URL or model name refuses startup", () => {
    expect(() => readChatConfig({ ARRA_CHAT_PROVIDER: "bogus" })).toThrow(/ARRA_CHAT_PROVIDER/);
    for (const url of ["not a url", "ftp://127.0.0.1:11434", "http://user:pw@127.0.0.1:11434", "http://127.0.0.1:11434/?q=1"]) {
      expect(() => readChatConfig({ ARRA_CHAT_PROVIDER: "ollama", ARRA_CHAT_URL: url }), url).toThrow(/ARRA_CHAT_URL/);
    }
    for (const model of ["gemma3 4b", "x".repeat(300), "bad\nname"]) {
      expect(() => readChatConfig({ ARRA_CHAT_PROVIDER: "ollama", ARRA_CHAT_MODEL: model })).toThrow(/ARRA_CHAT_MODEL/);
    }
  });
});

describe("createChatModel: settings exposed, model address never", () => {
  test("unconfigured and unimplemented slots have no model and null settings", () => {
    for (const env of [{}, { ARRA_CHAT_PROVIDER: "anthropic" }, { ARRA_CHAT_PROVIDER: "openai" }]) {
      const built = createChatModel(env);
      expect(built.settings).toBeNull();
      expect(built.model).toBeUndefined();
    }
  });

  test("ollama: effective settings without the URL, and a callable model", () => {
    const built = createChatModel({ ARRA_CHAT_PROVIDER: "ollama", ARRA_CHAT_URL: stub.url });
    expect(built.settings).toEqual({ provider: "ollama", model: "gemma3:4b", max_output_tokens: 512, timeout_ms: 60000 });
    expect(typeof built.model).toBe("function");
  });
});

describe("renderChatPrompt: evidence with ids, the question, nothing else", () => {
  test("every item appears with its id; the question is last; no item means an explicit 'no evidence'", () => {
    const prompt = renderChatPrompt({
      question: "When is the deploy?",
      context_text: "",
      items: [item(ID, "the deploy moved to Thursday"), item("evidenceid00000000002", "ร้านปิดวันจันทร์", "other", "peer-b")],
    });
    expect(prompt.user).toContain(`[${ID}]`);
    expect(prompt.user).toContain("the deploy moved to Thursday");
    expect(prompt.user).toContain("ร้านปิดวันจันทร์");
    expect(prompt.user.trimEnd().endsWith("When is the deploy?")).toBe(true);
    expect(prompt.system).toContain("only");
    const empty = renderChatPrompt({ question: "anything?", context_text: "", items: [] });
    expect(empty.user).toContain("(no evidence)");
  });
});

describe("createOllamaChatModel: one bounded POST to /api/chat", () => {
  const config = (overrides: Record<string, unknown> = {}) => ({
    provider: "ollama" as const,
    model: "gemma3:4b",
    url: stub.url,
    max_output_tokens: 512,
    timeout_ms: 60000,
    ...overrides,
  });

  test("the request pins model, non-streaming and num_predict; the answer is the message content", async () => {
    const before = stub.requests.length;
    const model = createOllamaChatModel(config());
    const answer = await model({ question: "When?", context_text: "", items: [item(ID, "Thursday")] });
    expect(answer).toContain(`[${ID}]`);
    expect(stub.requests.length - before).toBe(1);
    const sent = stub.requests.at(-1)!;
    expect(sent.path).toBe("/api/chat");
    expect(sent.body.model).toBe("gemma3:4b");
    expect(sent.body.stream).toBe(false);
    expect(sent.body.options).toEqual({ num_predict: 512 });
    expect(sent.body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
  });

  test("a non-2xx answer rejects", async () => {
    stub.mode = "error";
    try {
      await expect(createOllamaChatModel(config())({ question: "q", context_text: "", items: [] })).rejects.toThrow();
    } finally {
      stub.mode = "ok";
    }
  });

  test("a model that never answers is aborted at the timeout, never a hang", async () => {
    stub.mode = "hang";
    const started = performance.now();
    try {
      await expect(
        createOllamaChatModel(config({ timeout_ms: 300 }))({ question: "q", context_text: "", items: [] }),
      ).rejects.toThrow();
    } finally {
      stub.mode = "ok";
    }
    expect(performance.now() - started).toBeLessThan(scaledMs(5000));
  });

  test("a reply with no message content rejects rather than answering empty", async () => {
    const empty = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ message: { content: "  " }, done: true }) });
    try {
      await expect(
        createOllamaChatModel(config({ url: `http://127.0.0.1:${empty.port}` }))({ question: "q", context_text: "", items: [] }),
      ).rejects.toThrow();
    } finally {
      empty.stop(true);
    }
  });
});
