// Chat model provider for `answerChat` (#32, overnight ruling R9,
// docs/overnight/DECISIONS.md): local Ollama, pluggable, stub in tests.
//
// A barrel over one function per file, the way `publication/service.ts` is.
// `composition.ts` imports it LAZILY, the way it imports `embed.ts`, so the
// composition graph can be imported without touching any of this. Nothing
// here reads env at import time; `readChatConfig` reads it when called.
//
//   ARRA_CHAT_PROVIDER  unset => unconfigured | ollama | anthropic, openai (slots)
//   ARRA_CHAT_MODEL     default gemma3:4b
//   ARRA_CHAT_URL       default OLLAMA_URL, else http://127.0.0.1:11434
//   limits (pinned)     512 output tokens, 60 s timeout

export { createChatModel } from "./chat-model.createChatModel";
export { createOllamaChatModel } from "./chat-model.createOllamaChatModel";
export { readChatConfig } from "./chat-model.readChatConfig";
export { renderChatPrompt } from "./chat-model.renderChatPrompt";
export type { ChatConfig, ChatProviderSlot, ComposedChatModel, OllamaChatConfig } from "./chat-model.types";
