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
 * call (service.createChatService.ts, a READER-side facade since #32 / R9).
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
/** D3b (DESIGN.md §12): the perspective keys. Admitted only when present, so
 *  every existing request is unchanged; omitted and null both mean "any". They
 *  narrow which conclusions are SELECTED and never who may read: the requester
 *  is still `peer_name`, under exactly the same membership rule. */
const PERSPECTIVE_KEYS = ["observer_peer_name", "subject_peer_name"] as const;
const GET_CHAT_SETTINGS_KEYS = ["workspace_name"] as const;

export type GetContextRequest = {
  workspace_name: string;
  peer_name: string;
  session_name: string;
  max_items: number;
  observer_peer_name: string | null;
  subject_peer_name: string | null;
};

export type AnswerChatRequest = GetContextRequest & { question: string };

export type GetChatSettingsRequest = { workspace_name: string };

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

/** An optional perspective name: absent or null is "any", else the same
 *  name grammar as every other peer name here. */
function perspective(o: JcsObject, key: (typeof PERSPECTIVE_KEYS)[number]): string | null {
  const value = o.get(key);
  return value === undefined || value === null ? null : name(value, [key]);
}

export function parseGetContext(bytes: Uint8Array): GetContextRequest {
  const raw = parseRequest(bytes);
  const o = requireClosedObject(raw, [...GET_CONTEXT_KEYS, ...PERSPECTIVE_KEYS.filter((key) => raw.has(key))], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    peer_name: name(o.get("peer_name"), ["peer_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    max_items: maxItems(o.get("max_items"), ["max_items"]),
    observer_peer_name: perspective(o, "observer_peer_name"),
    subject_peer_name: perspective(o, "subject_peer_name"),
  };
}

export function parseAnswerChat(bytes: Uint8Array): AnswerChatRequest {
  const raw = parseRequest(bytes);
  const o = requireClosedObject(raw, [...ANSWER_CHAT_KEYS, ...PERSPECTIVE_KEYS.filter((key) => raw.has(key))], []);
  return {
    workspace_name: name(o.get("workspace_name"), ["workspace_name"]),
    peer_name: name(o.get("peer_name"), ["peer_name"]),
    session_name: name(o.get("session_name"), ["session_name"]),
    question: question(o.get("question"), ["question"]),
    max_items: maxItems(o.get("max_items"), ["max_items"]),
    observer_peer_name: perspective(o, "observer_peer_name"),
    subject_peer_name: perspective(o, "subject_peer_name"),
  };
}

/** `getChatSettings` names only its scope. The settings are process
 *  configuration, not workspace data, so the scope is admission's, not a
 *  lookup key -- but the object is still closed like every other request. */
export function parseGetChatSettings(bytes: Uint8Array): GetChatSettingsRequest {
  const o = requireClosedObject(parseRequest(bytes), GET_CHAT_SETTINGS_KEYS, []);
  return { workspace_name: name(o.get("workspace_name"), ["workspace_name"]) };
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

/**
 * One source handle of a conclusion revision (D3b), read from the revision's
 * own `link_snapshot_json` -- written WITH the revision, never behind a
 * separate derivation. A handle into a session the requester may not read is
 * dropped, and only a coarse flag says so: never its id, never a count.
 */
export type ConclusionSource = {
  relation: string;
  target_kind: string;
  target: unknown;
  capture_status: string;
};

/** One eligible CURRENT `conclusion` revision (R10: a type term, not a
 *  table), with the ids a citation needs and the perspective it was recorded
 *  from. `text` is the revision body. */
export type ConclusionItem = {
  node_id: string;
  revision_id: string;
  revision_no: string;
  title: string;
  text: string;
  author_peer_name: string | null;
  observer_peer_name: string | null;
  subject_peer_name: string | null;
  session_name: string | null;
  created_at: string;
  sources: ConclusionSource[];
  sources_incomplete: boolean;
};

/**
 * Slice 10 (DESIGN.md §12 "budget"). There is NO tokenizer in this server, so
 * `tokenizer` is null and `token_count_kind` always says "estimate", naming
 * the heuristic: never an exact token claim. The enforced limits are still
 * the item count and the wire-byte budget.
 */
export type ContextBudget = {
  max_items: number;
  max_wire_bytes: number;
  used_wire_bytes: number;
  tokenizer: null;
  token_count_kind: "estimate";
  estimate_heuristic: "ceil(utf8_bytes/4)";
  estimated_tokens: number;
  /** Any count, byte or scan bound stopped an eligible candidate. */
  truncated: boolean;
};

/**
 * Slice 10 (DESIGN.md §12 "freshness"). Assembly time is not an atomic
 * snapshot: the watermarks are the table versions this read observed.
 * Context reads no search index, so its watermark is "unknown", not a zero.
 */
export type ContextFreshness = {
  assembled_at: string;
  source_watermarks: Record<string, number>;
  index_watermark: "unknown";
};

export type ContextResult = {
  items: ChatContextItem[];
  /** D3b: requested and effective scope, and the perspective selected by. */
  scope: {
    session_name: string;
    effective_sessions: string[];
    observer_peer_name: string | null;
    subject_peer_name: string | null;
  };
  conclusions: ConclusionItem[];
  /** A stored `summary` revision in scope, else null -- never made up per read. */
  summary: ConclusionItem | null;
  /** Coarse: false when any eligible conclusion or source was withheld
   *  (protected, bounded or budgeted). Never a count, never an id. */
  conclusions_coverage: { complete: boolean };
  budget: ContextBudget;
  freshness: ContextFreshness;
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
export function renderContextText(items: ChatContextItem[], conclusions: ConclusionItem[] = []): string {
  const messages = items.map((item) => `[${item.session_name}] ${item.peer_name}: ${item.content}`);
  // D3b: conclusions render with their revision id, so a model can cite it.
  const views = conclusions.map(
    (c) => `[conclusion ${c.revision_id}] ${c.observer_peer_name ?? "any"} -> ${c.subject_peer_name ?? "any"}: ${c.text}`,
  );
  return [...views, ...messages].join("\n");
}

export type ChatModelInput = {
  question: string;
  context_text: string;
  items: ChatContextItem[];
  /** D3b. `answerChat` always sends it; optional so a model adapter that
   *  predates conclusions still type-checks and simply ignores them. */
  conclusions?: ConclusionItem[];
};

/** The chat model call, injected exactly like `Clock` is injected elsewhere
 *  in this kernel: a real caller supplies a real model, a test supplies a
 *  stub, and NOTHING in this file or in the read-only `getContext` path ever
 *  invokes one on its own. Production builds one from env in
 *  `src/chat-model.ts` (#32 / R9). */
export type ChatModelFn = (input: ChatModelInput) => Promise<string>;

/** The effective chat settings `getChatSettings` reports (#32 / R9). Never
 *  the model's address: configuration a caller may see, not where it lives. */
export type ChatSettings = {
  provider: string;
  model: string;
  max_output_tokens: number;
  timeout_ms: number;
};

/** `{model: null}` is the unconfigured answer: no model, nothing to report. */
export type ChatSettingsResult = ChatSettings | { model: null };

export type AnswerChatResult = {
  answer: string;
  coverage: ContextResult["coverage"];
  excluded: ExcludedContextItem[];
  excluded_omitted: number;
  items_used: string[];
  /** D3b: node/revision citations, beside the message ids above. */
  conclusions_used: { node_id: string; revision_id: string }[];
  conclusions_coverage: ContextResult["conclusions_coverage"];
  budget: ContextBudget;
  freshness: ContextFreshness;
};

/**
 * Map an absent or failed MODEL call onto the closed publication code set:
 * `model_unavailable` (#32, overnight ruling R9; chat-v1.md amendment).
 *
 * One code for every way a model can fail to produce an answer -- none
 * configured, unreachable, timed out, answered non-2xx, answered nothing --
 * because the caller acts on all of them the same way: nothing was read
 * wrongly, nothing was written, retry later or configure a model.
 *
 * It used to REUSE `writer_unavailable`, which made "no model", "model
 * failed" and "the dataset writer is busy" one indistinguishable 503 -- and
 * the writer case was a real, separate defect (#32 analysis) that the reuse
 * hid. A model failure is not a writer failure: `answerChat` no longer touches
 * a writer at all.
 */
export function mapModelFailure(): never {
  return failPublication("model_unavailable", "");
}
