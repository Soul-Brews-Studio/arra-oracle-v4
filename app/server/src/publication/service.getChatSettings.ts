import { type ChatSettings, type ChatSettingsResult, parseGetChatSettings } from "./chat";

/**
 * The effective chat settings (#32 / R9), or `{model: null}` when no model is
 * configured. Model-free and dataset-free: it reports configuration, contacts
 * nothing and reads no table, so it answers the same for every workspace the
 * caller is admitted to.
 */
export async function getChatSettings(settings: ChatSettings | null, requestBytes: Uint8Array): Promise<ChatSettingsResult> {
  parseGetChatSettings(requestBytes);
  return settings === null ? { model: null } : { ...settings };
}
