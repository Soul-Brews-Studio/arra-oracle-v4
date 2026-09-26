import { requireBoundedText, requireClosedObject, requireNonemptyString } from "../contracts/common";
import { fail } from "../contracts/errors";
import { MAX_NAME_BYTES } from "./context.constants";
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
  /** The peer closing it: must be a CURRENT member. Null is the operator
   *  path (audit:read, checked by the service), recorded as `by_peer: null`. */
  peer_name: string | null;
  /** The caller's retry key for THIS session's close. Deliberately not
   *  nanoid-shaped, like lifecycle's operation_id -- but, unlike lifecycle's,
   *  stored inside the session row, so it is capped like a name. */
  operation_id: string;
};

/**
 * K9 `closeSession` (docs/overnight/V3-PARITY.md §5; DECISIONS.md R18 D7).
 * Closed like every context request: all keys required, nulls explicit.
 * A reason that is only whitespace says nothing about why, and the close
 * record exists to say why, so it is refused (no trimming: a reason that has
 * text is stored exactly as sent).
 */
export function parseCloseSession(bytes: Uint8Array): CloseSessionRequest {
  const o = requireClosedObject(parseRequest(bytes), KEYS, []);
  const reason = requireBoundedText(requireNonemptyString(o.get("reason") ?? null, ["reason"]), MAX_REASON_BYTES, ["reason"]);
  if (reason.trim() === "") fail("invalid_value", ["reason"], "must not be blank");
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    reason,
    peer_name: nullableName(o.get("peer_name"), ["peer_name"]),
    operation_id: requireBoundedText(requireNonemptyString(o.get("operation_id") ?? null, ["operation_id"]), MAX_NAME_BYTES, ["operation_id"]),
  };
}
