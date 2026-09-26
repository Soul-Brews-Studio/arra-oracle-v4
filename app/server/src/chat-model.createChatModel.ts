import { createOllamaChatModel } from "./chat-model.createOllamaChatModel";
import { readChatConfig } from "./chat-model.readChatConfig";
import type { ComposedChatModel } from "./chat-model.types";

/**
 * Build the chat model and its effective settings from env (R9).
 *
 * Unconfigured, and the unimplemented `anthropic`/`openai` slots, yield no
 * model and `settings: null`: `answerChat` answers `model_unavailable` and
 * `getChatSettings` answers `{model: null}`. The settings never include the
 * model's URL -- the same rule `bank_info` follows for the embedder.
 */
export function createChatModel(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): ComposedChatModel {
  const config = readChatConfig(env);
  if (config.provider !== "ollama") return Object.freeze({ settings: null, model: undefined });
  return Object.freeze({
    settings: Object.freeze({
      provider: config.provider,
      model: config.model,
      max_output_tokens: config.max_output_tokens,
      timeout_ms: config.timeout_ms,
    }),
    model: createOllamaChatModel(config, fetchImpl),
  });
}
