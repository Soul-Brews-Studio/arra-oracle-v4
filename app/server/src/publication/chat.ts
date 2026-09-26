/**
 * #32 evidence-grounded chat -- the PURE half.
 *
 * Request grammar, the reduced wire projection of an already-encoded message
 * row, and response composition -- all without a dataset, a gate, a model or
 * a network call. Styled on `read-cursor.ts`: governed ContractError via
 * `fail()` for grammar violations, `PublicationError` via `failPublication()`
 * for corrupt input this module was handed, `requireClosedObject` for every
 * request shape. No SDK import, and nothing here acquires, retains or returns
 * a connection, table, adapter, owner or model handle.
 *
 * NO REPRESENTATION TABLE. There is no persisted "chat" or "conclusion" row
 * anywhere in this kernel's nineteen tables, and this module does not invent
 * one: `getContext` and `answerChat` (service.ts) derive everything here from
 * `messages` rows the caller already owns, re-projected through
 * `context.ts`'s own `encodeMessageRow`. This file only shapes the REQUEST
 * and the RESPONSE around that derivation; service.ts owns the retrieval,
 * the per-session authorization (service.getContext.ts, #85) and the model
 * call.
 */

import { requireBoundedText, requireClosedObject, requireNonemptyString, type Tokens } from "../contracts/common";
import { fail } from "../contracts/errors";
import { parseStrictBytes, type JcsObject, type JcsValue } from "../contracts/jcs";
import { failPublication } from "./errors";

const MAX_REQUEST_BYTES = 1048576;
const MAX_REQUEST_DEPTH = 64;
const MAX_NAME_BYTES = 256;
/** A question is a single caller-supplied string, not a document. */
const MAX_QUESTION_BYTES = 4096;

/** Upper bound on how many context items one call may compose. Request-side;
 *  service.ts may still return FEWER, reporting why via `coverage` and
 *  `excluded`. */
export const MAX_CONTEXT_ITEMS = 50;
/**
 * Cumulative wire budget for the assembled context array, mirroring
 * `context.ts`'s own `MAX_RESULT_WIRE_BYTES` refuse-don't-truncate discipline
 * but sized for a MODEL PROMPT rather than a paginated response: this is
 * about to be pasted into one request body, not paged through by a client.
 */
export const MAX_CONTEXT_WIRE_BYTES = 65536;
/** How many sessions LINKED from the requested one contribute candidate
 *  messages. Bounded, never a corpus walk -- the same shape as every other
 *  bounded exception in this kernel (`MAX_RECONCILE_REVISIONS`, `MAX_CYCLE_VISITED`). */
export const MAX_LINKED_SESSIONS = 8;

const GET_CONTEXT_KEYS = ["workspace_name", "peer_name", "session_name", "max_items"] as const;
const ANSWER_CHAT_KEYS = ["workspace_name", "peer_name", "session_name", "question", "max_items"] as const;

export type GetContextRequest = {
  workspace_name: string;
  peer_name: string;
  session_name: string;
  max_items: number;
};

export type AnswerChatRequest = GetContextRequest & { question: string };

function parseRequest(bytes: Uint8Array, tokens: Tokens = []): JcsObject {
  if (!(bytes instanceof Uint8Array)) {
    // A non-bytes entrypoint would be a second, ungoverned parser path.
    fail("invalid_type", tokens, "expected request bytes");
  }
  const parsed = parseStrictBytes(bytes, tokens, { maxBytes: MAX_REQUEST_BYTES, maxDepth: MAX_REQUEST_DEPTH });
  if (!(parsed instanceof Map)) fail("invalid_type", tokens, "expected object");
  return parsed as JcsObject;
}

/** Nonempty valid Unicode, 256 UTF-8 bytes. No trim, no case fold, no NFC. */
function name(value: JcsValue | undefined, tokens: Tokens): string {
  return requireBoundedText(requireNonemptyString(value ?? null, tokens), MAX_NAME_BYTES, tokens);
}

/** A small JSON integer, deliberately: this bounds a compose-time count, not
 *  an Int64 wire field. */
function maxItems(value: JcsValue | undefined, tokens: Tokens): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail("invalid_type", tokens, "expected integer");
  }
  if (value < 1 || value > MAX_CONTEXT_ITEMS) {
    fail("invalid_value", tokens, `expected 1..${MAX_CONTEXT_ITEMS}`);
  }
  return value;
}

/** Nonempty valid Unicode, bounded, exactly like `name` but its own bound:
 *  a question is not a scoped identity and must not borrow that grammar. */
function question(value: JcsValue | undefined, tokens: Tokens): string {
  return requireBoundedText(requireNonemptyString(value ?? null, tokens), MAX_QUESTION_BYTES, tokens);
}

export function parseGetContext(bytes: Uint8Array): GetContextRequest {
  const o = requireClosedObject(parseRequest(bytes), GET_CONTEXT_KEYS, []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    peer_name: name(o.get("peer_name"), ["peer_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    max_items: maxItems(o.get("max_items"), ["max_items"]),
  };
}

export function parseAnswerChat(bytes: Uint8Array): AnswerChatRequest {
  const o = requireClosedObject(parseRequest(bytes), ANSWER_CHAT_KEYS, []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    peer_name: name(o.get("peer_name"), ["peer_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    question: question(o.get("question"), ["question"]),
    max_items: maxItems(o.get("max_items"), ["max_items"]),
  };
}

/* ------------------------------------------------------------------ *
 * Response composition. PURE: given already-encoded message rows (never a
 * raw stored row -- `context.ts` owns that decode), assemble the wire
 * response. No SDK, no fetch, no model call anywhere in this file.
 * ------------------------------------------------------------------ */

export type ChatContextItem = {
  public_id: string;
  session_name: string;
  peer_name: string;
  role: unknown;
  content: string;
  seq_in_session: string;
  created_at: string;
};

/**
 * Project one already-VALIDATED message row (`context.ts`'s own
 * `encodeMessageRow` output) to the reduced shape a chat prompt needs.
 *
 * Deliberately re-checks type, not shape: `encodeMessageRow` already proved
 * the row is a real message; this only proves the SUBSET this module reads
 * is still what it expects, the same discipline `read-cursor.ts`'s
 * `storedText` applies to a value it did not itself decode from bytes.
 */
export function projectContextItem(encodedMessage: Record<string, unknown>): ChatContextItem {
  const { public_id, session_name, peer_name, role, content, seq_in_session, created_at } = encodedMessage;
  if (typeof public_id !== "string") failPublication("integrity_failure", "");
  if (typeof session_name !== "string") failPublication("integrity_failure", "");
  if (typeof peer_name !== "string") failPublication("integrity_failure", "");
  if (typeof content !== "string") failPublication("integrity_failure", "");
  if (typeof seq_in_session !== "string") failPublication("integrity_failure", "");
  if (typeof created_at !== "string") failPublication("integrity_failure", "");
  return { public_id, session_name, peer_name, role: role ?? null, content, seq_in_session, created_at };
}

/**
 * An AUTHORIZED candidate a budget or count bound stopped. It keeps its
 * identifiers: they belong to sessions the requester is a current member of.
 *
 * The one session-level entry is the linked-session bound
 * (`MAX_LINKED_SESSIONS`): both fields are null, because the set of linked
 * sessions that were never searched is open-ended and may include sessions
 * the requester is not a member of, so naming one would be a disclosure.
 */
export type BudgetExcludedContextItem =
  | { reason: "budget_exceeded"; session_name: string; public_id: string }
  | { reason: "budget_exceeded"; session_name: null; public_id: null };

/**
 * Every authorization exclusion of one call, folded into ONE anonymous entry
 * (#85, overnight ruling R4). Listing them by `public_id`/`session_name`
 * disclosed exactly what the membership check exists to withhold. `count` is
 * the number of candidate messages refused, at most `max_items + 1` per
 * unauthorized linked session (the same per-session lookahead an authorized
 * session gets), so it is a lower bound, never an overcount.
 */
export type UnauthorizedContextExclusion = { reason: "unauthorized"; count: number };

export type ExcludedContextItem = BudgetExcludedContextItem | UnauthorizedContextExclusion;

export type ContextResult = {
  items: ChatContextItem[];
  /** `"full"` ONLY when nothing was excluded for any reason (#85, R4):
   *  `excluded` is empty and `excluded_omitted` is 0. Any unauthorized
   *  exclusion, any budget/count stop and the linked-session bound all make
   *  it `"partial"`. It answers "is this everything?", not "is this
   *  everything you may see?" -- the second question gave a false "yes" to
   *  the first. */
  coverage: "full" | "partial";
  excluded: ExcludedContextItem[];
  /** How many `budget_exceeded` entries were NOT listed because `excluded`
   *  reached its own byte bound (`MAX_CONTEXT_WIRE_BYTES`). The list's own
   *  truncation signal; 0 when the list is complete. */
  excluded_omitted: number;
};

/** One wire-byte measurement, matching `context.ts`'s own `rowWireBytes`
 *  convention (JSON text, UTF-8 bytes) but over the REDUCED chat shape. */
export function contextItemWireBytes(item: ChatContextItem): number {
  return new TextEncoder().encode(JSON.stringify(item)).length;
}

/**
 * Deterministic transcript rendering for the model prompt.
 *
 * PURE string assembly only. This text is what eventually crosses into the
 * injected model call (service.ts), but building it is not itself a model
 * call, and this function never invokes one.
 */
export function renderContextText(items: ChatContextItem[]): string {
  return items.map((item) => `[${item.session_name}] ${item.peer_name}: ${item.content}`).join("\n");
}

export type ChatModelInput = {
  question: string;
  context_text: string;
  items: ChatContextItem[];
};

/** The chat model call, injected exactly like `Clock` is injected elsewhere
 *  in this kernel: a real caller supplies a real model, a test supplies a
 *  stub, and NOTHING in this file or in the read-only `getContext` path ever
 *  invokes one on its own. */
export type ChatModelFn = (input: ChatModelInput) => Promise<string>;

/**
 * Map a thrown MODEL failure (timeout, rate limit, truncated stream, or any
 * other model-call exception) onto the CLOSED publication code set.
 *
 * Neither existing envelope was built for this. A governed `ContractError`
 * is about malformed REQUEST bytes -- the request here is fine. The seven
 * `PublicationErrorCode`s are about persistence and stored-state outcomes --
 * nothing was written or read incorrectly; an external generation call
 * simply did not complete.
 *
 * DECISION: `writer_unavailable`. Its existing meaning in this file --
 * "the thing this call depends on to do its job is not available right now"
 * (see `openContextWriter`'s `OWNERS.has(canonical)` gate check) -- already
 * describes a model timeout, a rate limit or a truncated stream from the
 * caller's side: retry later, nothing was corrupted. `invalid_request` is
 * wrong because the CALLER did nothing wrong. `recovery_required` is wrong
 * because nothing was durably written, so there is no ambiguous window to
 * recover from -- `answerChat` never touches the owner's write queue at all.
 * No new code is added to the closed set; this is a reuse, not an extension.
 */
export function mapModelFailure(): never {
  return failPublication("writer_unavailable", "");
}
