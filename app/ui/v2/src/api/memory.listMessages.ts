import { type Bank } from "./memory";
import { call } from "./memory.call";

/** #87 / R3: membership is a read boundary on `listMessages`/`getMessage`.
 *  Name a `requester_peer_name` and the server answers only if that peer is a
 *  CURRENT member of the session. Omit it and the call is the operator view,
 *  which needs `audit:read` on the bank -- the dev-stack operator token has it;
 *  a `content:read`-only token gets 403 `forbidden`. */
export const listMessages = (
  b: Bank,
  session_name: string,
  limit = 50,
  after_seq: string | null = null,
  requester_peer_name: string | null = null,
) =>
  call(b, "listMessages", {
    session_name,
    limit,
    after_seq,
    ...(requester_peer_name === null ? {} : { requester_peer_name }),
  });
