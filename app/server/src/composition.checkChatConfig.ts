/**
 * Validate the chat model configuration (#32 / R9) the way `readConfig`
 * validates the rest: at startup, before listen, failing closed. Contacts no
 * model -- reachability is a per-answer outcome (`model_unavailable`), not a
 * startup precondition, so a stopped Ollama never stops the server.
 */
export async function checkChatConfig(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { readChatConfig } = await import("./chat-model");
  readChatConfig(env);
}
