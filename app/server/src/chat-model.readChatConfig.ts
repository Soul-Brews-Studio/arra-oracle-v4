import {
  CHAT_MAX_OUTPUT_TOKENS,
  CHAT_TIMEOUT_MS,
  DEFAULT_CHAT_MODEL,
  DEFAULT_CHAT_URL,
  type ChatConfig,
} from "./chat-model.types";

/** An Ollama model reference: `name[:tag]`, optionally namespaced. No spaces,
 *  no control characters, bounded. */
const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,200}$/;

/** An empty variable reads as unset, the way `VAR= cmd` is written. */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Read and validate the chat model configuration. Called at startup, never at
 * import, and fails CLOSED the same way `composition.ts`'s `readConfig` does:
 * a malformed value refuses startup rather than failing the first question.
 *
 * - `ARRA_CHAT_PROVIDER` unset: unconfigured. `answerChat` answers
 *   `model_unavailable`; nothing is contacted.
 * - `ollama`: the one implemented provider. `ARRA_CHAT_MODEL` defaults to
 *   gemma3:4b. `ARRA_CHAT_URL` defaults to `OLLAMA_URL` -- the local Ollama
 *   `embed.ts` already uses -- and then to http://127.0.0.1:11434.
 * - `anthropic` / `openai`: named slots, unimplemented, so unconfigured.
 * - anything else: refused.
 */
export function readChatConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig {
  const provider = setting(env, "ARRA_CHAT_PROVIDER");
  if (provider === undefined) return { provider: null };
  if (provider === "anthropic" || provider === "openai") return { provider };
  if (provider !== "ollama") {
    throw new Error("ARRA_CHAT_PROVIDER must be ollama, anthropic or openai (only ollama is implemented)");
  }

  const model = setting(env, "ARRA_CHAT_MODEL") ?? DEFAULT_CHAT_MODEL;
  if (!MODEL_NAME.test(model)) {
    throw new Error("ARRA_CHAT_MODEL must be a model name such as gemma3:4b (letters, digits, . _ : / -, at most 200)");
  }

  const raw = setting(env, "ARRA_CHAT_URL") ?? setting(env, "OLLAMA_URL") ?? DEFAULT_CHAT_URL;
  const invalid = () =>
    new Error("ARRA_CHAT_URL (else OLLAMA_URL) must be an http(s) base URL without credentials, query or fragment");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid();
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw invalid();
  }

  return Object.freeze({
    provider: "ollama",
    model,
    url: parsed.href.replace(/\/+$/, ""),
    max_output_tokens: CHAT_MAX_OUTPUT_TOKENS,
    timeout_ms: CHAT_TIMEOUT_MS,
  });
}
