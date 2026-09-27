# Evidence-grounded chat v1

Status: **DRAFT — NOT RATIFIED.** Written against shipped code (`app/server/src/publication/chat.ts`
and the `getContext`/`answerChat` additions to `service.ts`, commit `6546e0c` "feat(chat):
evidence-grounded chat orchestration (#32)") to close a real gap: #32 shipped with no contract
document at all, while four sibling kernels on this branch each have one. This document is a
DESCRIPTIVE first pass, not an authored design. It has not been reviewed or ratified by anyone
holding contract authority on this project, is not cited from any source file, and must not be
treated as frozen. Nothing here authorizes a source change, merge-order decision, or citation
of a digest as ratified.

Parent `Soul-Brews-Studio/arra-oracle-v4#28`. Base: `6546e0c` on `v4/issue-32-chat-kernel`
(chat.ts + service.ts additions + `chat-service.test.ts` + `fixtures/chat-v1/gated-chat.ts`).
This slice's test file lives outside the `v4/kernel-contracts` branch where this draft is being
written — read via `git show v4/issue-32-chat-kernel:<path>`, not present in this branch's
working tree.

No physical schema. `chat.ts` states this directly: **no `chat` or `conclusion` table exists**
in the nineteen tables this kernel writes to, and this slice does not add one. `getContext` and
`answerChat` derive everything from `messages` rows the caller already owns (via `session_links`
for cross-session candidates, `session_peers`/`peers` for authorization), re-projected through
`context.ts`'s own `encodeMessageRow`. Nothing here is a new stored representation.

## 1. Request grammar

```
getContext  {workspace_name:S(<=256B), peer_name:S(<=256B), session_name:S(<=256B), max_items:1..50}
answerChat  {workspace_name:S(<=256B), peer_name:S(<=256B), session_name:S(<=256B),
             question:S(<=4096B), max_items:1..50}
```

All keys required, closed object (`requireClosedObject`), raw Uint8Array JSON at most 1 MiB /
depth 64, same `parseStrictBytes` discipline every other pure module in this package uses. Name
fields (`workspace_name`, `peer_name`, `session_name`) are nonempty valid Unicode, <=256 UTF-8
bytes, no trim/case-fold/NFC — the same `name()` grammar as every other kernel's scoped
identifiers. `question` has its **own** 4096-byte bound, deliberately separate from `name`'s
256-byte bound: chat.ts's own comment states a question "is not a scoped identity and must not
borrow that grammar." `max_items` is a small JSON integer, 1..50 inclusive (`MAX_CONTEXT_ITEMS`);
an out-of-range or non-integer value is `invalid_value` at `/max_items` (governed `ContractError`,
proven by `chat-service.test.ts`'s `max_items` test). An unexpected field is `unexpected_field`,
governed, not a publication envelope — also proven directly in the test file.

`answerChat`'s grammar is exactly `getContext`'s four fields plus `question`; `AnswerChatRequest`
is typed as `GetContextRequest & { question: string }` in the source.

## 2. Result shapes

```
getContext  -> { items: ChatContextItem[], coverage: "full"|"partial", excluded: ExcludedContextItem[] }
answerChat  -> { answer: string, coverage: "full"|"partial", excluded: ExcludedContextItem[], items_used: string[] }
```

`ChatContextItem`: `{ public_id, session_name, peer_name, role, content, seq_in_session,
created_at }` — the reduced wire projection `projectContextItem` builds from an already-encoded
`encodeMessageRow` output, not the raw stored row.

`ExcludedContextItem`: `{ reason: "unauthorized"|"budget_exceeded", session_name, public_id:
string|null }`. These are the **only** two exclusion reasons; there is no third. Both outcomes
are returned values, never thrown, and both can appear together in one call's `excluded` array
(`chat-service.test.ts` proves this directly — one `unauthorized` entry and one
`budget_exceeded` entry in the same response).

`coverage: "partial"` fires whenever a **budget or count bound** stopped an authorized candidate
from being included. An authorization exclusion alone does **not** flip coverage to `"partial"`
— chat.ts's own comment states this explicitly: "dropping a peer's own out-of-scope item is
correct access control, not incompleteness." This means a response can carry `unauthorized`
entries in `excluded` while still reporting `coverage: "full"`, if nothing else was dropped for
budget reasons. A caller reading only `coverage` to decide "did I get everything I'm allowed to
see" would miss this — `excluded` must be inspected regardless of `coverage`'s value.

`answerChat.items_used` is the list of `public_id`s from `contextResult.items` — i.e. exactly
the authorized, budget-capped set that was rendered into the model's context text. It is not a
separate authorization pass; it is `getContext`'s own already-filtered output, echoed back.

## 3. Errors — this slice's codes

Two envelopes, reused unchanged from the rest of this kernel, never a third:

- Governed `ContractError` / `arra-error/v1` for grammar (`unexpected_field`, `invalid_type`,
  `invalid_value`, `missing_field`, etc.) — `toJSON()` is exactly `version, code, path, message`,
  no `name`.
- `PublicationError` / `arra-publication-error/v1` for persistence/reference/state.

The full closed set is eight codes (`PUBLICATION_ERROR_CODES` in `errors.ts`): `invalid_request,
not_found, invalid_reference, integrity_failure, writer_unavailable, unsupported_dataset,
recovery_required, limit_exceeded`. This slice's own code paths use exactly two of them:

- **`invalid_reference`** — at `/workspace_name` (no such workspace), `/session_name` (no such
  session in that workspace), and `/peer_name` (the peer named in the request either does not
  exist, or exists but holds no CURRENT membership — i.e. never joined, or `left_at !== null` —
  in the session being checked). `requireCurrentMembership` uses this single code+path for
  **both** "peer doesn't exist" and "peer isn't currently a member" — the two cases are not
  distinguished in the thrown error.
- **`writer_unavailable`** — the fixed mapping for **any** model-call exception
  (`mapModelFailure`), regardless of the model's actual failure mode (timeout, rate limit,
  truncated stream, or anything else it might throw). `chat.ts`'s own comment documents the
  reasoning: `invalid_request` is wrong because the caller did nothing wrong, `recovery_required`
  is wrong because nothing was durably written by this path. No code is added to the closed set.

`not_found` is **not** used anywhere in this slice — absence is always `invalid_reference` (a
missing session/workspace) or a structurally-reported `excluded` entry (an unauthorized or
budget-dropped candidate), never a thrown `not_found`. Following the `session-link-v1.md`
precedent: this is a statement about this slice's own code paths, not a claim that `not_found`
is removed from the shared envelope.

`integrity_failure` and `limit_exceeded` are declared in the shared set but **not** reachable
through any code path in `chat.ts` or the `getContext`/`answerChat` methods themselves as read —
see the linked-session bound in §5, which is the one place a corpus-shaped bound exists but is
enforced by silent truncation rather than by throwing `limit_exceeded`.

## 4. Facade and export impact — measured

Before this slice: context writer facade = 22 methods (its own 11 plus the 11 reader methods it
spreads in, per the existing `context-ownership.test.ts` comment); context reader facade = 11.
This slice adds exactly two methods (`getContext` to the reader-spread set, `answerChat` writer-
only), verified in the shipped diff to `context-ownership.test.ts`, `context-service.test.ts` and
`association-ownership.test.ts`:

- Writer: 22 -> **24**.
- Reader: 11 -> **12**.

Runtime export count is **unchanged at nine**: `openPublicationReader, openPublicationWriter,
openKnowledgeReader, openKnowledgeWriter, openContextReader, openContextWriter,
openEvidenceReader, openEvidenceWriter` (8 `open*` factories) plus the re-exported
`PublicationError` class — verified by grepping `service.ts`'s top-level `export` statements at
this commit. No new factory, no new bundle key, no new close method.

## 5. Boundary and bound behavior — measured, including one gap

- **BigInt, not Number, for cross-session ordering.** `getContext`'s candidate sort compares
  `created_at` as `bigint` (`typeof av !== "bigint"` throws `integrity_failure` otherwise) —
  the same discipline this project's own tonight's-audit notes elsewhere: a plain JS `Number`
  silently corrupts a value in this range. Ties break on `public_id` string comparison for a
  fully deterministic order.
- **Per-item authorization runs BEFORE composition, never after.** `getContext` calls
  `requireCurrentMembership` on every candidate individually, and only pushes to `items` if it
  passes; a rejected candidate is never added and then filtered — it is never added at all.
  `chat-service.test.ts` proves the unauthorized candidate's content never reaches
  `renderContextText`'s output or the model's own input, in either the rendered text or the raw
  items array.
- **Linked-session bound is enforced by silent truncation, not by reporting.** `getContext` reads
  up to `MAX_LINKED_SESSIONS + 1` (9) rows from `session_links` and takes only the first 8
  (`MAX_LINKED_SESSIONS`) via `.slice(0, MAX_LINKED_SESSIONS)`. **UNRESOLVED / gap, not a
  guarantee this document invents**: unlike every other keyset read in this package (e.g.
  `session-link-v1.md`'s own `listSessionLinks`, which uses the same "`limit+1` lookahead" shape
  specifically to detect and refuse an ambiguous page edge), this lookahead row here is fetched
  and then simply dropped — there is no `limit_exceeded` throw, no `excluded` entry, and no
  `coverage: "partial"` signal for a session that had a 9th (or later) linked session whose
  messages were never even considered as candidates. A caller cannot distinguish "this session
  has at most 8 linked sessions" from "this session has more, and some were silently never
  searched." This document does not know whether that is intentional (linked-session count is
  expected to stay small) or an oversight carried over from a bound that was designed for a
  different, reportable purpose elsewhere in the file.
- **The `max_items + 1` per-session lookahead has no corresponding duplicate/edge check either**,
  but this one does not silently drop information: every fetched row becomes a `Candidate`,
  enters the cross-session sort, and is then subject to the ordinary `budget_exceeded`
  accounting once the combined pool exceeds `request.max_items` — so nothing here is lost
  without being reported, unlike the linked-session case above.
- **Wire budget accounting**: `budget` starts at 2 (bracket bytes) and each item adds
  `contextItemWireBytes(item) + 1` (comma), matching `context.ts`'s own `rowWireBytes`
  convention applied to the reduced chat shape. `MAX_CONTEXT_WIRE_BYTES` = 65536, explicitly
  sized (per `chat.ts`'s own comment) "for a MODEL PROMPT... this is about to be pasted into one
  request body, not paged through by a client" — a deliberately different purpose from
  `context.ts`'s own `MAX_RESULT_WIRE_BYTES`, not a copy-paste of the same number.
- **`answerChat` is never wrapped in `mutate()`/`core.serial`.** Nothing in this path is durably
  written, so it does not share the write queue or the poison state that guards actual
  persistence — a slow or failing model call must not block or fail an unrelated `appendMessages`
  turn. This is a real, load-bearing asymmetry from every *writer* method elsewhere in this file.

## 6. The model boundary — resolved, not left ambiguous

The lane brief for #32 asked whether `answerChat`'s model call is a real network call or an
injected stub, because a test cannot be written against an ambiguous boundary. Checked directly
against the shipped commit:

- `ChatModelFn` is `(input: ChatModelInput) => Promise<string>` — purely an injected function
  type. `chat.ts` contains **no SDK import, no fetch, no network call of any kind** (its own file
  header states this explicitly and is true by inspection).
- `service.ts` wires it as `const model: ChatModelFn = options.model ?? (() =>
  mapModelFailure());` on `createContextWriterService` — i.e. **absent by default**. If no caller
  supplies `options.model`, the first `answerChat` call maps straight to `writer_unavailable`
  without ever attempting anything.
- Grepping the entire tree at this commit for callers of `openContextWriter(` or
  `openEvidenceWriter(` outside `service.ts`'s own definitions and the test suite finds **zero**
  production call sites. `app/server/src/index.ts` and `app/server/src/mcp/index.ts` (the two
  files that look like they might wire an HTTP/MCP entrypoint) do not reference either factory at
  all as of this commit.

**Conclusion**: as shipped, `answerChat`'s model boundary is not "ambiguous" — it is **entirely
unwired in production**. The only place a model implementation exists at all is the in-process
stub in `test/fixtures/chat-v1/gated-chat.ts` (`modelMode: "ok" | "fail"`), which is code, never
serialized, and exists purely to let the test count calls. There is no real network call
anywhere in this codebase today, and — more broadly than just the model — **no HTTP or MCP
entrypoint calls `context.getContext` or `context.answerChat` at all**; the entire context/
evidence facade (not just chat) currently has test-only callers. This is worth stating plainly
rather than leaving as a hedge: whoever ratifies this contract should decide whether "unwired to
any entrypoint" is in scope for a v1 sign-off, or whether that wiring is tracked as separate,
later work.

## 7. Affected files (from the shipped commit)

- `app/server/src/publication/chat.ts` — new, pure grammar + result codec (217 lines).
- `app/server/src/publication/service.ts` — `getContext`/`answerChat` additions to
  `createContextReadMethods`/`createContextWriterService`, `model` option threaded through
  `ContextOptions`, `openContextWriter`, `openEvidenceWriter` (213 lines added).
- `app/server/test/chat-service.test.ts` — new smoke test (207 lines).
- `app/server/test/fixtures/chat-v1/gated-chat.ts` — new gated child fixture (152 lines).
- `app/server/test/context-ownership.test.ts`, `app/server/test/association-ownership.test.ts`,
  `app/server/test/context-service.test.ts` — closed method-list assertions amended for the
  22->24 / 11->12 facade counts (§4).
- Per the commit message, `read-cursor-ownership.test.ts` and `read-cursor-service.test.ts` were
  also amended for the same reason; not independently re-verified for this draft.

## 8. Boundaries reused unchanged

Same owner registry, serial queue (for `getContext`, which is a `reads` method, not wrapped in
`mutate`), attempted-write/poison, one-shot close as the rest of the context/evidence kernel.
Same governed strict-parse/closed-object/name/`ContractError` primitives (`common.ts`,
`contracts/errors.ts`, `contracts/jcs.ts`) as every other pure module. Same `PublicationError`/
`failPublication` envelope as every other kernel. Same `requireCurrentMembership` primitive
`appendMessages` already uses for write-side authorization — this slice reuses it for read-side
authorization rather than inventing a second check. Same `orderedProjection`/`refresh` adapter
capabilities; no new adapter method. Same `encodeMessageRow`/`encodeSessionLinkRow` encoders,
unmodified.

## 9. What this draft does NOT claim

- Not ratified, not frozen, not cited from any source file.
- Does not independently re-verify every claim in `chat-service.test.ts` by running the suite —
  claims here are read from the test source and cross-checked against `chat.ts`/`service.ts`
  source, not from an executed test run.
- Does not resolve the linked-session silent-truncation gap in §5 — flagged, not fixed, not
  assigned an owner.
- Does not cover ownership, recovery, or precision test lanes for this kernel — only
  `chat-service.test.ts` (a smoke test, by its own file header, "not exhaustive") exists today.
  Queue-exclusion-under-contention, poison-both-directions, kill-after-write recovery, and a
  dedicated Int64/BigInt boundary sweep beyond what the smoke test exercises are not covered by
  any test file as of this commit.
- Does not take a position on whether `answerChat` being unwired to any production entrypoint
  (§6) is acceptable for a v1 freeze — that is a product/scope call for whoever ratifies this.

## Amendment 2026-09-26 (overnight R4)

Source: `docs/overnight/DECISIONS.md` **R4** ("`coverage` means complete, not 'complete within
what you may see'"), ruling on `Soul-Brews-Studio/arra-oracle-v4#85`. The sections above are left
as written. Where they disagree with this amendment, this amendment wins.

### What changed

1. **`coverage` means complete.** `coverage` is `"full"` only when nothing was excluded for any
   reason: `excluded` is empty and `excluded_omitted` is 0. An unauthorized exclusion, a
   `max_items` stop, a wire-budget stop and the linked-session bound each make it `"partial"`.
   This replaces the §2 paragraph that said an authorization exclusion alone does not flip
   coverage. The old rule gave a false "yes" to the question the field exists to answer ("is
   this everything?"). `chat-service.test.ts` asserted `"full"` for that case, and that assertion
   is changed along with this amendment.
2. **Unauthorized items are never identified.** Listing them by `public_id` and `session_name` was
   itself the leak. All authorization exclusions in one call fold into a single entry,
   `{ reason: "unauthorized", count }`. It appears only when `count > 0`. `count` is the number of
   candidate messages refused. Each unauthorized linked session contributes at most
   `max_items + 1` of them, the same per-session lookahead an authorized session gets, so `count`
   can undercount but never overcounts.
3. **Budget and limit exclusions keep their identifiers**, because they belong to sessions the
   requester is a current member of: `{ reason: "budget_exceeded", session_name, public_id }`.
4. **The linked-session bound is reported.** This resolves the §5 "UNRESOLVED / gap" and the
   matching §9 bullet. When `session_links` holds more than `MAX_LINKED_SESSIONS` (8) rows from
   the anchor, the `+ 1` lookahead row is no longer discarded silently. It produces one
   session-level entry, `{ reason: "budget_exceeded", session_name: null, public_id: null }`. It
   names no session, because the set of unsearched sessions is open-ended and may include
   sessions the requester is not a member of. It is conservative: a ninth row that duplicates an
   earlier target still reports the bound.
5. **`excluded` has its own truncation signal.** The list is byte-bounded by a budget the same
   size as the item budget (`MAX_CONTEXT_WIRE_BYTES`, 65536) but separate from it. Entries past
   the bound are counted in a new result field, `excluded_omitted: number`, which is 0 when the
   list is complete. Overflow no longer borrows `coverage`. The fixed entries (the unauthorized
   count, then the link bound) go first, so they are never the ones omitted.
6. **Authorization runs once per session, before any message row is read.** It used to run per
   candidate, after the `max_items` gate. That ordering recorded an unauthorized candidate past
   the cap as `budget_exceeded`, with its `public_id` attached. An unauthorized session is now
   only counted. The count reads a projection of the ordering column alone, so no content and no
   identifier of that session enters the process. Membership lookups per call drop from up to
   459 to at most 9.

### Result shapes, as amended

```
getContext  -> { items, coverage: "full"|"partial", excluded: ExcludedContextItem[], excluded_omitted: number }
answerChat  -> { answer, coverage, excluded, excluded_omitted, items_used: string[] }

ExcludedContextItem =
    { reason: "unauthorized",    count: number }                              // at most one, first
  | { reason: "budget_exceeded", session_name: null,   public_id: null }      // link bound, at most one
  | { reason: "budget_exceeded", session_name: string, public_id: string }    // one per stopped item
```

`answerChat` passes only `items` to the model. Every item passed the per-session membership
check, and `excluded` is never rendered into the prompt. `answerChat` returns the same `coverage`,
`excluded` and `excluded_omitted` that `getContext` computed.

### Caller impact

- This is a wire change on HTTP `POST /api/knowledge/:bank/getContext|answerChat` and on MCP
  `kb_getContext` / `kb_answerChat`. The UI (`app/ui/v2` `CoverageBadge`, `ExcludedList`,
  `api/memory.ts`, and the v1 `knowledge.html`) was updated in the same change.
- `"partial"` is **not a retry signal**. The same request by the same requester returns the same
  exclusions. Read `excluded` to learn why.

### Evidence

`app/server/test/chat-coverage.test.ts` runs a real gated dataset. It covers all eight scenarios
(unauthorized, full, count, wire, unauthorized-after-cap, ninth link, 408 unauthorized
candidates, byte-bounded overflow), the recording stub model, and the same assertions over live
HTTP and MCP against the production reader.

## Amendment 2026-09-26 (overnight R9 (+ R4 already merged))

Source: `docs/overnight/DECISIONS.md` **R9** ("#32 chat model: local Ollama, pluggable, stub in
tests"), ruling on `Soul-Brews-Studio/arra-oracle-v4#32`. The R4 amendment above is already merged
and is unchanged by this one: `coverage`, `excluded` and `excluded_omitted` mean exactly what it
says. The sections above are left as written. Where they disagree with this amendment, this
amendment wins.

### What changed

1. **`answerChat` is a read, and runs on the reader.** It is no longer a method of the context
   writer facade (`createContextWriterService`). It lives on a chat facade,
   `createChatService(reader, { model, settings })` (`service.createChatService.ts`), built over a
   reader's `getContext`. The knowledge transport composes that facade onto the READER bundle
   (`createKnowledgeAccess` → `bundle.chat`), for HTTP and MCP alike. The per-request "ephemeral
   writer" (`getEphemeralWriter`, the registry flag `ephemeralWrite`) is deleted from both
   transports. The context writer options (`ContextOptions`, `EvidenceOptions`) no longer carry
   `model`. This replaces §4's "answerChat writer-only" and §6's "wired on
   `createContextWriterService`". The writer facade loses exactly `answerChat`; the reader facades
   and the nine runtime exports are unchanged.
   - **Why:** measured in `.tmp/understand/analysis-32.json` and pinned by
     `chat-gate-coexistence.test.ts` against the real fd-42 gate. In one gated server process the
     ephemeral writer contended for the single `OWNERS` slot, so every `answerChat` after any write
     answered `writer_unavailable`; and its `close()` released the process's only inherited gate,
     so every write after the first `answerChat` answered `writer_unavailable` until restart.
2. **Admitted under `content:read`** (was `content:write`). It reads and persists nothing. The model
   is shown exactly the `items` that `getContext` returns to the same caller, so admitting it under
   the same action widens nothing. A `content:write`-only credential is now refused `answerChat`
   (403). The R3 peer binding on `/peer_name` applies unchanged.
3. **New method `getChatSettings`** (`content:read`, also `kb_getChatSettings` and
   `kb getChatSettings`). Request `{workspace_name}`, closed. It returns the effective settings
   `{provider, model, max_output_tokens, timeout_ms}`, or `{model: null}` when no model is
   configured. It never returns the model's address. It is model-free and dataset-free.
4. **New closed error code `model_unavailable`** (`arra-publication-error/v1`, appended to
   `PUBLICATION_ERROR_CODES`; HTTP 503; MCP `isError` carrying the same envelope, message
   `"chat model unavailable"`). This replaces §3's mapping of model failures onto
   `writer_unavailable`, which made "no model", "model failed" and "the dataset writer is busy"
   indistinguishable. It is returned when:
   - no model is configured (`ARRA_CHAT_PROVIDER` unset, or one of the unimplemented slots
     `anthropic` / `openai`): refused **before** any dataset read or model call;
   - the configured model cannot answer: unreachable, the 60 s timeout, a non-2xx reply, a
     malformed reply, or an empty answer. The model is tried exactly once.

   Precedence: grammar (`ContractError`) → `model_unavailable` if unconfigured → `getContext`'s own
   refusals (`invalid_reference`, …) → one model call → `model_unavailable` if it fails. Never a
   500, never a hang, never `writer_unavailable`.
5. **Model wiring, from env, at composition** (`src/chat-model.ts`, imported lazily by
   `composition.ts` the way `embed.ts` is):

   | variable | meaning |
   |---|---|
   | `ARRA_CHAT_PROVIDER` | unset/empty: unconfigured. `ollama`: the one implemented provider. `anthropic`, `openai`: named slots, unconfigured. Anything else refuses startup. |
   | `ARRA_CHAT_MODEL` | default `gemma3:4b` |
   | `ARRA_CHAT_URL` | default `OLLAMA_URL` (the embedder's Ollama), else `http://127.0.0.1:11434`. http(s), no credentials, query or fragment. |
   | limits (pinned, not env) | 512 output tokens (`num_predict`), 60 s `AbortSignal` timeout |

   A malformed value refuses startup (`checkChatConfig`, right after `readConfig`). Reachability is
   not a startup check: a stopped Ollama never stops the server; it makes answers
   `model_unavailable`. The request is `POST {url}/api/chat` with
   `{model, stream: false, messages: [system, user], options: {num_predict: 512}}`; redirects are
   refused. The prompt is built from `items` only: fixed instructions, then one evidence line per
   item, `[public_id] session / peer: content`, then the question. The instructions say the evidence
   is recorded understanding, not a live agent, and ask the model to cite ids in brackets.
   `items_used` stays the authoritative citation list; nothing is parsed out of the model's text.
6. **Dev default:** `app/just/scripts/run_dev_server.py` sets `ARRA_CHAT_PROVIDER=ollama` unless
   the variable is already exported (an exported empty value means unconfigured). `bun src/index.ts`
   on its own stays unconfigured.

### Result shapes, as amended

```
getChatSettings -> { provider: string, model: string, max_output_tokens: number, timeout_ms: number }
                 | { model: null }
answerChat      -> unchanged from the R4 amendment: { answer, coverage, excluded, excluded_omitted, items_used }
```

### Unauthorized evidence never reaches the model

`chat-production-wiring.test.ts` points a production-composed server at a recording Ollama stub
on 127.0.0.1 and asserts on the exact request bytes the model received. The prompt holds the
asking peer's own session evidence. It never holds a linked session's secret that the peer is not
a member of, nor any other workspace's data. The R4 in-process stub assertions in
`chat-coverage.test.ts` still hold.

### Caller impact

- `content:read`-only credentials can now call `answerChat`. Before, they got 403.
- `content:write`-only credentials can no longer call it (403).
- `answerChat` no longer answers `writer_unavailable`. A client that read that code as "no model"
  should read `model_unavailable`.
- The v2 UI (`ModelNote.tsx`), the v1 `knowledge.html` hint and `kb <method> --help` were updated
  in the same change. The CLI waits up to 75 s for `answerChat`, longer than the server's 60 s model
  bound, so a slow answer arrives as the server's own result.

### Not changed, stated so nobody infers it

- `getContext`'s grammar and result, R4's coverage semantics, and `items_used`.
- There is no `effort` parameter: R9 rules no effort enum, so the grammar stays closed and `effort`
  is still `unexpected_field`.
- The Anthropic and OpenAI providers are not implemented, and there is no cost ceiling, as R9 says
  while the model is local.
- Save/revise actions, observer/subject and context v2 (#32 slices C and D) are not part of this
  amendment.

### Evidence

`chat-gate-coexistence.test.ts` (real gate, HTTP and MCP, both orders, three answers then a write),
`chat-production-wiring.test.ts` (HTTP, MCP and CLI; configured, unconfigured, unreachable and
failing model; prompt isolation), `chat-model.test.ts` (config validation, request shape, timeout),
`knowledge-chat-writer-gate.test.ts` (routing: reader only, no writer).

## Amendment 2026-09-26 (post-merge R3/R4/R5 + #85/#31/#75 acceptance criteria)

Evidence only; no behaviour changes. Ruling R4 (`docs/overnight/DECISIONS.md`) is
unchanged. Two overflow cases for the `excluded` list are now proven through the HTTP
route handler (`POST /api/knowledge/:bank/getContext|answerChat`) and the MCP route
handler (`POST /mcp/:bank`, `kb_getContext|kb_answerChat`), not only through the
service. Both run through `createApp`'s `app.handle` in-process, with the production
reader and a real policy file; neither runs over a TCP socket.

- **Overflow.** An anchor plus 4 linked sessions, 5 x 51 candidates at `max_items`
  50, with 250-byte session names: 205 budget entries against the list's 65,536-byte
  bound. This is an overflow case, not the largest one: the anchor plus
  `MAX_LINKED_SESSIONS` (8) linked sessions allows 9 x 51 candidates.
- **Mixed overflow.** An anchor plus 9 linked sessions. Two of them the requester
  never joined, and the 9th link is past `MAX_LINKED_SESSIONS`. The fixed
  unauthorized aggregate and the link-bound entry are the first two entries, ahead
  of 307 overflowing budget entries, and neither is ever omitted.

On both transports and for both methods, `coverage` is `"partial"`, `excluded` stays
within `MAX_CONTEXT_WIRE_BYTES`, `excluded_omitted` is greater than 0, and every
budget entry is either listed or counted. The wire `excluded`, `excluded_omitted` and
items (`items` for `getContext`, `items_used` for `answerChat`) equal the in-process
result. `answerChat` uses a stub model. Test: `app/server/test/chat-coverage.test.ts`:
"the excluded list is byte-bounded ...", "under overflow the unauthorized aggregate
and the link bound still lead the list", and the describe block "the same results
over the live transports". A mutant that records the two fixed entries after the item
loop fails 5 of those tests.

## Amendment 2026-09-26 (post-merge Nat 2026-09-28 NAT-DECISIONS D3b: peer representation plus node/revision-grounded context IS owed (AC-MATRIX slice 11, then slice 10))

**Change.** Chat is no longer grounded in messages only. The introduction's "no `conclusion`
table" statement still holds: a conclusion is the reserved `type` term of R10, stored as an
ordinary node revision. No table was added.

- **Request grammar (§1).** `getContext` and `answerChat` accept two OPTIONAL keys,
  `observer_peer_name` and `subject_peer_name` (`S(<=256B)` or null). When they are omitted,
  the request and its behaviour are what they were before. They narrow which conclusions are
  selected. They never change permissions: the requester is still `peer_name`, with the same
  current-membership rule. They are not acting peers, so `PEER_FIELDS` does not list them. A
  name that is not a peer of the workspace is `invalid_reference` at that field. That check
  runs after the requester's own membership check.
- **Result (§2).** `getContext` adds `scope` (requested session, effective sessions,
  observer, subject), `conclusions`, `summary`, `conclusions_coverage: {complete}`,
  `budget` and `freshness`. `answerChat` adds `conclusions_used: [{node_id, revision_id}]`
  (citations beside `items_used` message ids), `conclusions_coverage`, `budget` and
  `freshness`. The selection rule, the conclusion shape and the budget and freshness blocks
  are defined in `representation-v1.md` §4-§5. `getContext` shares them with the new
  `getRepresentation`.
- **Read boundary.** A conclusion recorded in a session the requester is not a current
  member of is withheld. So is a source handle into such a session. Only coarse flags report
  it: `conclusions_coverage.complete: false`, `sources_incomplete: true`, `coverage:
  "partial"`. No counts and no ids. `coverage` is `"full"` only when neither messages nor
  conclusions were excluded. This extends R4.
- **Budget.** Conclusions come first in the existing `MAX_CONTEXT_WIRE_BYTES` budget, and
  messages share what is left. Conclusions are also bounded by `max_items`. `budget` names an
  ESTIMATE (`tokenizer: null`, `token_count_kind: "estimate"`, `ceil(utf8_bytes/4)`). This
  server has no tokenizer and claims no exact token count.
- **Freshness.** `assembled_at` is the registry's request time, the same value used as the
  eligibility `as_of`. The source watermarks are table versions. `index_watermark` is
  `"unknown"`, because context reads no search index.
- **Prompt.** `renderContextText` puts one line per conclusion before the messages:
  `[conclusion <revision_id>] <observer> -> <subject>: <text>`. The model input also
  carries `conclusions`.
- **Surfaces.** HTTP and MCP carry the keys unchanged through the registry. The CLI aliases
  `context get` and `chat ask` take `--observer` and `--about`, and send the keys only when
  those flags are given.

**Reason.** Nat ruled D3b on 2026-09-28 (`docs/overnight/NAT-DECISIONS.md`, recorded in
`docs/overnight/DECISIONS.md`). Peer representation plus node/revision-grounded context is
owed before #32 and #31 can close. This amendment is AC-MATRIX slice 11 (then slice 10), as
DESIGN.md §12 specifies.

**Evidence.** `app/server/test/context-peer-representation.test.ts` (14 tests) runs against a
real gated dataset through the production registry, HTTP and MCP.
