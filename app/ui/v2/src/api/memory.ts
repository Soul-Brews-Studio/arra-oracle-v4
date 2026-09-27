/** Typed wrappers over the CONTEXT tier -- the Honcho-shaped part of the API.
 *
 * v1 is a method picker: 26 endpoints, a JSON textarea, a response pane. v2
 * is a memory browser, so it only touches the subset that models memory:
 * peers, sessions, messages, assembled context and the dialectic answer.
 *
 * ONE constraint shapes this whole UI and is worth stating before the code:
 * there is NO enumeration endpoint. The registry has `getPeer` and
 * `getSession`, never `listPeers` or `listSessions`. A Honcho dashboard opens
 * on a populated sidebar; this one cannot, because the server genuinely
 * cannot answer "which peers exist". The roster in `state/roster.ts` is a
 * LOCAL list of names you have typed or created, and every entry is verified
 * against the server before it is shown as real. See that file for why this
 * is honest rather than a workaround.
 */
export type Bank = { bank: string; token: string; workspace: string };

/** Mirrors `context.encodeMessageRow` -- only the fields this UI renders. */
export type MessageRow = {
  public_id: string;
  session_name: string;
  peer_name: string;
  content: string;
  role: string | null;
  seq_in_session: string;
  created_at: string;
  in_reply_to?: string | null;
};

/** Mirrors `chat.ChatContextItem`. */
export type ContextItem = {
  public_id: string;
  session_name: string;
  peer_name: string;
  role: unknown;
  content: string;
  seq_in_session: string;
  created_at: string;
};

/** Mirrors `chat.ExcludedContextItem` (#85, overnight ruling R4).
 *  Unauthorized exclusions are ONE anonymous count, never listed by id: the
 *  ids were the leak. Budget/count stops keep their identifiers; both-null
 *  is the linked-session bound, which names no session on purpose. */
export type ExcludedItem =
  | { reason: "budget_exceeded"; session_name: string; public_id: string }
  | { reason: "budget_exceeded"; session_name: null; public_id: null }
  | { reason: "unauthorized"; count: number };

/** `coverage` is `"full"` only when nothing at all was excluded. */
export type ContextResult = {
  items: ContextItem[];
  coverage: "full" | "partial";
  excluded: ExcludedItem[];
  /** Budget entries not listed because `excluded` hit its byte bound. */
  excluded_omitted: number;
};

export type ChatAnswer = {
  answer: string;
  coverage: "full" | "partial";
  excluded: ExcludedItem[];
  excluded_omitted: number;
  items_used: string[];
};

/** `MAX_ITEMS` in `context.parseAppendMessages` -- one append, at most 128. */
export const MAX_APPEND_ITEMS = 128;
/** `MAX_PAGE_LIMIT` in `context.parseListMessages`. */
export const MAX_PAGE_LIMIT = 100;

/** The server's error envelope, `arra-error/v1` and its two siblings. Shown
 *  verbatim rather than flattened to a string: the `code` is the part worth
 *  reading, and `pointer` says exactly which field was refused. */
export type ErrorEnvelope = { code?: string; pointer?: string; message?: string };

// Functions split out (style-ui-split2, docs/overnight/DECISIONS.md): each
// lives in its own file named after itself. Re-exported here so importers
// do not churn.
export { newPublicId } from "./memory.newPublicId";
export { getPeer } from "./memory.getPeer";
export { getSession } from "./memory.getSession";
export { registerPeer } from "./memory.registerPeer";
export { registerSession } from "./memory.registerSession";
export { joinSession } from "./memory.joinSession";
export { listMessages } from "./memory.listMessages";
export { appendMessage } from "./memory.appendMessage";
export { getContext } from "./memory.getContext";
export { answerChat } from "./memory.answerChat";
export { getReadCursor } from "./memory.getReadCursor";
export { asError } from "./memory.asError";
