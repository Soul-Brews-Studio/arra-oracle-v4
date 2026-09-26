// Chat model configuration (#32, overnight ruling R9, docs/overnight/DECISIONS.md).
//
// Types and the pinned limits only. The limits are deliberately NOT env
// settings: R9 pins them ("max output 512 tokens; timeout 60 s"), and a knob
// nobody ruled on is a knob somebody turns by accident.

import type { ChatModelFn, ChatSettings } from "./publication/chat";

/** Output tokens one answer may use (Ollama `num_predict`). */
export const CHAT_MAX_OUTPUT_TOKENS = 512;
/** Wall-clock bound on one model call, enforced with an AbortSignal. */
export const CHAT_TIMEOUT_MS = 60_000;
/** Small, local, handles Thai; installed on m5 (R9). */
export const DEFAULT_CHAT_MODEL = "gemma3:4b";
/** The local Ollama, same default as `embed.ts`'s OLLAMA_URL. */
export const DEFAULT_CHAT_URL = "http://127.0.0.1:11434";

/** Named interface slots: recognised, so a typo cannot pass validation, and
 *  unimplemented, so they fail closed as unconfigured until a provider and a
 *  credential path are ruled on. */
export type ChatProviderSlot = "anthropic" | "openai";

export type OllamaChatConfig = {
  readonly provider: "ollama";
  readonly model: string;
  /** Base URL, no trailing slash. Never exposed through any read. */
  readonly url: string;
  readonly max_output_tokens: number;
  readonly timeout_ms: number;
};

export type ChatConfig =
  | { readonly provider: null }
  | { readonly provider: ChatProviderSlot }
  | OllamaChatConfig;

/** What composition hands the chat service: both absent, or both present. */
export type ComposedChatModel = {
  readonly settings: ChatSettings | null;
  readonly model: ChatModelFn | undefined;
};
