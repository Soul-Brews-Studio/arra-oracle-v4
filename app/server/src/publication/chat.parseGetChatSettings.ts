// Split from chat.ts (style-split4b, 2026-09-28).
import { requireClosedObject } from "../contracts/common";
import { name } from "./chat.name";
import { parseRequest } from "./chat.parseRequest";
import { GET_CHAT_SETTINGS_KEYS, type GetChatSettingsRequest } from "./chat.state";

/** `getChatSettings` names only its scope. The settings are process
 *  configuration, not workspace data, so the scope is admission's, not a
 *  lookup key -- but the object is still closed like every other request. */
export function parseGetChatSettings(bytes: Uint8Array): GetChatSettingsRequest {
  const o = requireClosedObject(parseRequest(bytes), GET_CHAT_SETTINGS_KEYS, []);
  return { workspace_name: name(o.get("workspace_name"), ["workspace_name"]) };
}
