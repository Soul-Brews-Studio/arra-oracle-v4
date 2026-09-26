import { requireClosedObject } from "../contracts/common";
import { name } from "./context.name";
import { nanoid } from "./context.nanoid";
import { parseRequest } from "./context.parseRequest";
import { sessionTitleMetadata } from "./context.sessionTitleMetadata";

/** `h_metadata` is the canonical JSON text to store (K12a), or null. */
export type RegisterSessionRequest = { workspace_name: string; session_id: string; name: string; h_metadata: string | null };

const KEYS = ["workspace_name", "session_id", "name"];
/** K12a (overnight R18): OPTIONAL, like #87's requester -- every existing
 *  caller omits it, and its absence already means "no title". */
const TITLE_KEY = "h_metadata";

export function parseRegisterSession(bytes: Uint8Array): RegisterSessionRequest {
  const raw = parseRequest(bytes);
  const o = requireClosedObject(raw, raw.has(TITLE_KEY) ? [...KEYS, TITLE_KEY] : KEYS, []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_id: nanoid(o.get("session_id"), ["session_id"]),
    name: name(o.get("name"), ["name"]),
    h_metadata: sessionTitleMetadata(o.get(TITLE_KEY), [TITLE_KEY]),
  };
}
