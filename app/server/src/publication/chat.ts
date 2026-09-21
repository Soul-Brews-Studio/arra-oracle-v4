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
 * the per-item authorization and the model call.
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
 *  service.ts may still return FEWER, reporting why via `coverage`. */
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

export type ExcludedContextItem = {
  reason: "unauthorized" | "budget_exceeded";
  session_name: string;
  public_id: string | null;
};

export type ContextResult = {
  items: ChatContextItem[];
  /** `"partial"` whenever a BUDGET or COUNT bound stopped an authorized
   *  candidate from being included -- reported structurally, never a silent
   *  truncation. Authorization exclusions are always listed in `excluded`
   *  too, but do not by themselves flip this to `"partial"`: dropping a peer's
   *  own out-of-scope item is correct access control, not incompleteness. */
  coverage: "full" | "partial";
  excluded: ExcludedContextItem[];
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
