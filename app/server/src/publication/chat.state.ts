/**
 * Split from chat.ts (style-split4b, 2026-09-28): data-only module identity --
 * request/response shapes, constants and injected function types. No parsing
 * or rendering logic here; see chat.<fn>.ts.
 */

export const MAX_REQUEST_BYTES = 1048576;
export const MAX_REQUEST_DEPTH = 64;
export const MAX_NAME_BYTES = 256;
/** A question is a single caller-supplied string, not a document. */
export const MAX_QUESTION_BYTES = 4096;

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

export const GET_CONTEXT_KEYS = ["workspace_name", "peer_name", "session_name", "max_items"] as const;
export const ANSWER_CHAT_KEYS = ["workspace_name", "peer_name", "session_name", "question", "max_items"] as const;
/** D3b (DESIGN.md §12): the perspective keys. Admitted only when present, so
 *  every existing request is unchanged; omitted and null both mean "any". They
 *  narrow which conclusions are SELECTED and never who may read: the requester
 *  is still `peer_name`, under exactly the same membership rule. */
export const PERSPECTIVE_KEYS = ["observer_peer_name", "subject_peer_name"] as const;
/**
 * R24 (Nat D3b, #32): an optional third narrowing key, `author_peer_name`.
 * SELECTION only, exactly like observer/subject -- it never grants access,
 * and it is deliberately NOT part of `getRepresentation`'s grammar: that
 * contract's `observer -> subject` view is one perspective's conclusions,
 * and adding a third axis there would let a caller merge perspectives
 * (any author within one observer/subject pair) rather than narrow one.
 * getContext/answerChat compose from many perspectives already, so a third
 * SQL predicate is a narrowing, not a merge.
 */
export const AUTHOR_KEYS = ["author_peer_name"] as const;
export const GET_CHAT_SETTINGS_KEYS = ["workspace_name"] as const;

export type GetContextRequest = {
  workspace_name: string;
  peer_name: string;
  session_name: string;
  max_items: number;
  observer_peer_name: string | null;
  subject_peer_name: string | null;
  author_peer_name: string | null;
};

export type AnswerChatRequest = GetContextRequest & { question: string };

export type GetChatSettingsRequest = { workspace_name: string };

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
    author_peer_name: string | null;
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
