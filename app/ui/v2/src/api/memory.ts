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
import { type ApiResult, callMethod } from "./client";

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

/** Mirrors `chat.ExcludedContextItem`. `unauthorized` is correct access
 *  control, NOT incompleteness -- only a budget/count stop flips coverage. */
export type ExcludedItem = {
  reason: "unauthorized" | "budget_exceeded";
  session_name: string;
  public_id: string | null;
};

export type ContextResult = {
  items: ContextItem[];
  coverage: "full" | "partial";
  excluded: ExcludedItem[];
};

export type ChatAnswer = {
  answer: string;
  coverage: "full" | "partial";
  excluded: ExcludedItem[];
  items_used: string[];
};

/** `MAX_ITEMS` in `context.parseAppendMessages` -- one append, at most 128. */
export const MAX_APPEND_ITEMS = 128;
/** `MAX_PAGE_LIMIT` in `context.parseListMessages`. */
export const MAX_PAGE_LIMIT = 100;

/** 21-char nanoid, the alphabet `parseAppendMessages` accepts. Generated
 *  client-side because `public_id` is caller-supplied: the server refuses a
 *  duplicate rather than minting one for you. */
export function newPublicId(): string {
  const alphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict";
  const bytes = new Uint8Array(21);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

const call = (b: Bank, method: string, body: Record<string, unknown>): Promise<ApiResult> =>
  callMethod(b.bank, method, { workspace_name: b.workspace, ...body }, b.token);

export const getPeer = (b: Bank, peer_name: string) => call(b, "getPeer", { peer_name });
export const getSession = (b: Bank, session_name: string) => call(b, "getSession", { session_name });
export const registerPeer = (b: Bank, peer_name: string) => call(b, "registerPeer", { peer_name });
export const registerSession = (b: Bank, session_name: string) => call(b, "registerSession", { session_name });
export const joinSession = (b: Bank, session_name: string, peer_name: string) =>
  call(b, "joinSession", { session_name, peer_name });

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

export const getContext = (b: Bank, peer_name: string, session_name: string, max_items = 20) =>
  call(b, "getContext", { peer_name, session_name, max_items });

export const answerChat = (
  b: Bank,
  peer_name: string,
  session_name: string,
  question: string,
  max_items = 20,
) => call(b, "answerChat", { peer_name, session_name, question, max_items });

export const getReadCursor = (b: Bank, peer_name: string, session_name: string) =>
  call(b, "getReadCursor", { peer_name, session_name });

/** The server's error envelope, `arra-error/v1` and its two siblings. Shown
 *  verbatim rather than flattened to a string: the `code` is the part worth
 *  reading, and `pointer` says exactly which field was refused. */
export type ErrorEnvelope = { code?: string; pointer?: string; message?: string };

export function asError(body: unknown): ErrorEnvelope | null {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;
  const err = (o.error ?? o) as Record<string, unknown>;
  if (typeof err !== "object" || err === null) return null;
  const code = typeof err.code === "string" ? err.code : undefined;
  if (code === undefined) return null;
  return {
    code,
    pointer: typeof err.pointer === "string" ? err.pointer : undefined,
    message: typeof err.message === "string" ? err.message : undefined,
  };
}
