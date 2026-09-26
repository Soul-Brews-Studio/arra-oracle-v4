import { requireBoundedText, requireClosedObject, requireNonemptyString } from "../contracts/common";
import { name } from "./context.name";
import { nullableName } from "./context.nullableName";
import { parseRequest } from "./context.parseRequest";

/** The same CHOSEN wire cap `lifecycle.ts` puts on a retire/supersede reason;
 *  no physical bound is declared for it. */
const MAX_REASON_BYTES = 4096;

const KEYS = ["workspace_name", "session_name", "reason", "peer_name", "operation_id"] as const;

export type CloseSessionRequest = {
  workspace_name: string;
  session_name: string;
  reason: string;
  /** The peer closing it: must be a CURRENT member. Null is the trusted
   *  workspace (operator) path, recorded as `by_peer: null`. */
  peer_name: string | null;
  /** The caller's retry key for THIS session's close. Deliberately not
   *  nanoid-shaped, like lifecycle's operation_id. */
  operation_id: string;
};

/**
 * K9 `closeSession` (docs/overnight/V3-PARITY.md §5; DECISIONS.md R18 D7).
 * Closed like every context request: all keys required, nulls explicit.
 */
export function parseCloseSession(bytes: Uint8Array): CloseSessionRequest {
  const o = requireClosedObject(parseRequest(bytes), KEYS, []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    reason: requireBoundedText(requireNonemptyString(o.get("reason") ?? null, ["reason"]), MAX_REASON_BYTES, ["reason"]),
    peer_name: nullableName(o.get("peer_name"), ["peer_name"]),
    operation_id: requireNonemptyString(o.get("operation_id") ?? null, ["operation_id"]),
  };
}
