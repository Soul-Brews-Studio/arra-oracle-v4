import type { ChatModelFn } from "./publication/chat";
import { renderChatPrompt } from "./chat-model.renderChatPrompt";
import type { OllamaChatConfig } from "./chat-model.types";

/**
 * A `ChatModelFn` over Ollama's `/api/chat`: one non-streaming POST per
 * answer, bounded by `num_predict` and an AbortSignal timeout.
 *
 * Every failure THROWS -- unreachable, timed out, non-2xx, malformed, or an
 * empty answer -- and nothing here decides what that means on the wire:
 * `answerChat` maps any throw to the closed `model_unavailable` code. The
 * error text is never surfaced (it could name the model's address).
 *
 * Redirects are refused: the request carries workspace evidence, and a
 * redirect could carry it to a host nobody configured.
 */
export function createOllamaChatModel(config: OllamaChatConfig, fetchImpl: typeof fetch = fetch): ChatModelFn {
  const endpoint = `${config.url}/api/chat`;
  return async (input) => {
    const prompt = renderChatPrompt(input);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        options: { num_predict: config.max_output_tokens },
      }),
      redirect: "error",
      // Covers the body read too: an answer that starts but never finishes
      // is aborted by the same deadline.
      signal: AbortSignal.timeout(config.timeout_ms),
    });
    if (!response.ok) throw new Error(`chat model answered ${response.status}`);
    const body = (await response.json()) as { message?: { content?: unknown } } | null;
    const content = body?.message?.content;
    if (typeof content !== "string" || content.trim() === "") throw new Error("chat model returned no answer");
    return content;
  };
}
