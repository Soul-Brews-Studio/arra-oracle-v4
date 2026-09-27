import { type Bank } from "./memory";
import { call } from "./memory.call";
import { newPublicId } from "./memory.newPublicId";

/** `message` and `source` are CLOSED objects server-side: an extra key is a
 *  refusal, not an ignored field. Keys here match `MESSAGE_KEYS` exactly. */
export const appendMessage = (
  b: Bank,
  session_name: string,
  peer_name: string,
  content: string,
  role: string | null,
  /** `messages.in_reply_to` is a nullable FK to another message's `public_id`,
   *  and it is the ONLY nesting this system has -- sessions are deliberately
   *  flat, no parent_id, no channel/thread split. So a reply tree is the
   *  whole of the structure, which is what the forum view renders. */
  in_reply_to: string | null = null,
) =>
  call(b, "appendMessages", {
    session_name,
    items: [
      {
        public_id: newPublicId(),
        message: { peer_name, role, content, in_reply_to },
        source: null,
      },
    ],
  });
