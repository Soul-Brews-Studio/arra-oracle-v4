// Split from chat.ts (style-split4b, 2026-09-28).
import { requireClosedObject } from "../contracts/common";
import { maxItems } from "./chat.maxItems";
import { name } from "./chat.name";
import { parseRequest } from "./chat.parseRequest";
import { perspective } from "./chat.perspective";
import { question } from "./chat.question";
import { ANSWER_CHAT_KEYS, AUTHOR_KEYS, PERSPECTIVE_KEYS, type AnswerChatRequest } from "./chat.state";

export function parseAnswerChat(bytes: Uint8Array): AnswerChatRequest {
  const raw = parseRequest(bytes);
  const o = requireClosedObject(
    raw,
    [...ANSWER_CHAT_KEYS, ...PERSPECTIVE_KEYS.filter((key) => raw.has(key)), ...AUTHOR_KEYS.filter((key) => raw.has(key))],
    [],
  );
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    peer_name: name(o.get("peer_name"), ["peer_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    question: question(o.get("question"), ["question"]),
    max_items: maxItems(o.get("max_items"), ["max_items"]),
    observer_peer_name: perspective(o, "observer_peer_name"),
    subject_peer_name: perspective(o, "subject_peer_name"),
    author_peer_name: perspective(o, "author_peer_name"),
  };
}
