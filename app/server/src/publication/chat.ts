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
 *
 * This file is now a barrel (style-split4b, 2026-09-28), a FROZEN CONTRACT
 * pipeline (app/docs/contracts/chat-v1.md): each exported function moved
 * verbatim to its own chat.<fn>.ts, private per-parser helpers used by only
 * one split file stayed there, and helpers shared by more than one split file
 * (`name`, `maxItems`, `question`, `perspective`, `parseRequest`) became their
 * own single-export chat.<helper>.ts files. Shapes/constants moved to
 * chat.state.ts (data only). Re-exported here so every existing importer
 * (`./publication/chat` / `../publication/chat` / `../src/publication/chat`)
 * keeps working unchanged -- see the dated amendment in chat-v1.md.
 *
 * ## Amendment 2026-09-26 (post-merge Nat style: one exported function per file,
 * named after the file (origin, Nat 2026-09-12: '1 file should not too long
 * can we split to function per file? like <= 600?'); ratchet
 * app/server/test/one-function-per-file.test.ts)
 *
 * `publication/chat.ts` moved from one file to a barrel of re-exports plus
 * one file per exported function (`chat.parseGetContext.ts`,
 * `chat.parseAnswerChat.ts`, `chat.parseGetChatSettings.ts`,
 * `chat.projectContextItem.ts`, `chat.contextItemWireBytes.ts`,
 * `chat.renderContextText.ts`, `chat.mapModelFailure.ts`), a data-only
 * `chat.state.ts`, and shared single-export helper files (`chat.name.ts`,
 * `chat.maxItems.ts`, `chat.question.ts`, `chat.perspective.ts`,
 * `chat.parseRequest.ts`). No behaviour changed: every function body moved
 * verbatim; `publication/chat.ts` is the same import path every caller
 * already used. Reason: docs/overnight/DECISIONS.md (overnight ruling on
 * Nat's one-function-per-file style) and the style-split4b slice brief
 * (SHRINK MULTI_EXPORT_ALLOWLIST, behaviour-preserving splits).
 */

export {
  MAX_CONTEXT_ITEMS,
  MAX_CONTEXT_WIRE_BYTES,
  MAX_LINKED_SESSIONS,
  type AnswerChatRequest,
  type AnswerChatResult,
  type BudgetExcludedContextItem,
  type ChatContextItem,
  type ChatModelFn,
  type ChatModelInput,
  type ChatSettings,
  type ChatSettingsResult,
  type ConclusionItem,
  type ConclusionSource,
  type ContextBudget,
  type ContextFreshness,
  type ContextResult,
  type ExcludedContextItem,
  type GetChatSettingsRequest,
  type GetContextRequest,
  type UnauthorizedContextExclusion,
} from "./chat.state";

export { parseGetContext } from "./chat.parseGetContext";
export { parseAnswerChat } from "./chat.parseAnswerChat";
export { parseGetChatSettings } from "./chat.parseGetChatSettings";
export { projectContextItem } from "./chat.projectContextItem";
export { contextItemWireBytes } from "./chat.contextItemWireBytes";
export { renderContextText } from "./chat.renderContextText";
export { mapModelFailure } from "./chat.mapModelFailure";
