# Context registration and ordered ingestion v1

Status: FROZEN IMPLEMENTATION CONTRACT — 2026-09-21. Root-owned.

Parent #28, foundation main `55ab093af0f28b5f57f41c38b126cd870854f696`. This is the dependency-first registration/ordered-message part, NOT closure of #28: session links, revision evidence/reverse queries, traces, cursors and read-only Relic integration remain required subsequent work. Implementation requires this file hash and exact ownership dispatch below; this contract does not authorize staging, commits, pushes, PRs, merges or deployment by workers.

## 1. Authority and composition
Reuse strict parser/common validators, prepareNewMessage, validateStoredSourceState and classifyMessageDestinationReplay unchanged. Preserve seven-field envelope/domain and accepted source semantics. No schema/dependencies/active transport/model/network/live data changes. Trusted local operator gate remains the boundary, not end-user authorization.

Add openContextWriter(root, options) and openContextReader(root) in publication/service.ts. Writer shape {publication,taxonomy,context,close}; nested existing facades retain existing key sets without close. Reader shape {publication,taxonomy,context}. Existing publication and knowledge factories retain EXACT current shapes. All writer factories share the single registry/queue/attempted-write/poison/one-shot-close. No exported owner, adapter, table, connection or generic callback loan. Context pure parsing/encoding lives in publication/context.ts, no SDK import. Factory options extend KnowledgeOptions with sourceNamespace:string|null and onContextBoundary; trusted configuration, not request JSON. Namespace selection is per writer instance; null selects local-only intake, non-null selects that exact source namespace. Readers need no namespace config.

Explicit compatibility amendment for this new slice: service runtime exports grow from five to seven by those two factories only. Existing five stay. Ownership lane owns the exact #49 assertion amendment in app/server/test/taxonomy-ownership.test.ts: sorted equality becomes [PublicationError, openContextReader, openContextWriter, openKnowledgeReader, openKnowledgeWriter, openPublicationReader, openPublicationWriter]. The separate forbidden-capability assertion stays. Update only this authorized surface addition, not unrelated expectations. Other frozen tests remain unchanged.

## 2. Requests (closed raw UTF-8 bytes)
All keys required, nullable values explicit, max request 1MiB/depth64 existing parser. W/name/session/peer use exact valid Unicode nonempty <=256 UTF-8 bytes, no normalization. N=nanoid21. I=canonical signed Int64 decimal string. JSON columns are initialized null in this registration slice; metadata/config mutation is not silently supplied here.

registerPeer {workspace_name:W,peer_id:N,name:S}
registerSession {workspace_name:W,session_id:N,name:S}
joinSession {workspace_name:W,session_name:S,peer_name:S}
appendMessages {workspace_name:W,session_name:S,items:[{public_id:N,message:{peer_name:S,role:string|null,content:string,in_reply_to:N|null},source:null|{source_message_id:S,source_created_at:T|null,supplied_digest:H|null}}]}
getPeer {workspace_name:W,peer_name:S}
getSession {workspace_name:W,session_name:S}
getMessage {workspace_name:W,public_id:N}
listMessages {workspace_name:W,session_name:S,after_seq:I|null,limit:number}

items is nonempty, at most128. Whole request grammar/format and duplicate requested public IDs are validated before any item mutates. Source key names are EXACTLY those of the existing prepareNewMessage interface (source_message_id/source_created_at), not message_id/created_at aliases; revision1 of this draft incorrectly abbreviated them. Duplicate IDs reject at later /items/i/public_id. role/content semantics remain exactly prepareNewMessage's accepted grammar, not an invented nonempty or enumeration restriction. Each item's source mode must agree with trusted namespace. limit is deliberately a JSON integer1..100 (small page size, NOT an Int64 wire field); after_seq remains canonical decimal TEXT. after_seq is an exclusive sequence cursor, not a timestamp or offset.

Caller-stable public_id is REQUIRED for BOTH local and sourced new records. This supplies local retry identity without a new operation journal. A sourced replay is still anchored to its source tuple, NOT to proposed public_id: if matching source exists it returns that original public_id and ignores a different unoccupied proposal. If the proposal names another row, conflict. Cross-workspace IDs confer no authority.

## 3. Registration and references
Resolve unique workspace before scoped identity; missing workspace invalid_reference /workspace_name, duplicate identity integrity_failure root. Peer/session IDs and names are each unique within workspace. Same scoped ID+name is already_satisfied retaining original timestamp and all current optional metadata/config fields; different ID holding name conflicts/name, requested ID carrying different name conflicts at ID pointer. Never merge peers by display metadata or label resemblance. New peer optional fields null. New session optional fields null and is_active=true. Already-present inactive session registration is already_satisfied, never reactivation.

joinSession resolves unique active session and unique peer in workspace. New membership writes joined_at from clock, left_at=null, optional fields null. Existing active triple is already_satisfied; existing left_at non-null conflicts (no implicit rejoin/rewrite/history loss). Rejoin is outside this slice; a left membership conflict is terminal through this interface until a separately reviewed lifecycle operation exists. Duplicate triples integrity_failure. Messages require active session, peer and active membership. Publication author/observer/subject remain independent; none inferred from writer identity.

in_reply_to must resolve uniquely within the SAME workspace AND session to an earlier stored message; missing/cross-session invalid_reference at the input pointer. Self reply refused. Forward references within a batch are not resolved prospectively; an earlier durably accepted item may be referenced. Existing reply chains must be checked for missing/cross-scope/cyclic stored state before accepting a new link; bounded 1024 visited, 1025 limit_exceeded. No request mutates an existing message or reply edge.

## 4. Allocation and replay
Use private ordered projection reads, NOT arbitrary limit-before-sort. The pinned @lancedb/lancedb0.38.0/apache-arrow18.1.0 local fixture probe measured negative, beyond-2^53 and Int64-max ordering and scoped where/orderBy/limit composition; root independently asserted eight exact outputs. This supports the selected query mechanism, not untested MemWAL/LSM modes or bounded engine effort. New physical id = max(0, the greatest stored message.id in dataset)+1. New seq = max(0, stored seq_in_session in requested workspace/session)+1. Compute with BigInt, reject Int64 overflow before write. Physical id is globally unique; public_id unique within workspace; sequence unique within workspace/session. Retained legacy signed values are not renumbered; gaps are allowed, never filled deliberately, no deletion in this interface. Gate+shared serial queue, NOT CAS, underpins uniqueness. Validate the selected maximum and use equality lookup to require its key unique; selected malformed/null extrema or duplicate keys fail integrity before allocation. Check proposed new global id/session sequence vacant before append and exactly unique after. This is NOT a whole-corpus corruption audit: non-extremal untouched duplicate legacy keys are not claimed detected by allocation. No dataset-size ceiling is introduced to make an arbitrary limited scan look complete. Read global/session maxima once per batch when the first NEW item requires allocation, then increment private BigInt high-water values under the held queue; replays consume none. The intended query projects only needed Int64 key columns, orders descending before limit1, and validates nulls before use. Ordered output bounds JS materialization, NOT SDK engine scan work or execution time. Do not select useLsm(false), enable MemWAL or change table configuration to bypass an unsupported query. Unknown ordered-query errors normalize safely; no approximate max or silent fallback to arbitrary limiting.

Sourced lookup is across requested WORKSPACE regardless of destination session, distinguishing0/1/>1; validate full stored row and recompute digest, then compare destination before digest classification. Exact source replay retains public_id/id/seq/created_at/ingested_at, clock and allocator not called. Changed payload conflicts/source_payload. Local lookup uses scoped public_id; stored destination session mismatch is governed scope_mismatch at /items/i/existing/session_name before immutable-state comparison, matching sourced replay classification. Then exact immutable request state returns original record, changed request conflicts/public_id. A local request cannot adopt a sourced row or conversely: mode/source identity difference conflicts/public_id, never strips or changes provenance. Registration/ref/policy/uniqueness checks still run on already-satisfied paths.

Retry comparison must not compare newly sampled intake time against stored intake. Supplied canonical source time IS in the source digest; local created_at/ingested_at are originally allocated state retained and validated, not caller assertions. token_count new value0 means not measured, not a tokenizer result; read/read_at/h_metadata/internal_metadata null. Their future mutation does not rewrite content identity. Persisted sourced digest is verified from actual envelope fields, not merely shape-checked.

## 5. Batch durability and results
Hold shared queue for the whole appendMessages call; reads remain outside it. Items process input order, one complete message row per SDK append. Intake clock sampled per NEW item only. Sourced created_at=source_created_at??intake; ingested_at=intake. Response includes original stored row for accepted/replayed items, not newly synthesized allocations.

Registration result {outcome:"created"|"already_satisfied",row} OR {outcome:"conflict",reason:"id"|"name"|"membership"}; no new error code for conflicts.
Batch result {outcome:"complete"|"stopped",results:[{index,outcome:"accepted"|"idempotent",row}],stop:null|{index,error:<existing safe error envelope>}|{index,conflict:"public_id"|"source_payload"}}. Stop on first runtime item rejection/conflict or persistence ambiguity; later items NOT attempted. Results include only individually readback-verified rows, never the ambiguous failed item. A crash may leave a longer durable prefix than an ACK proves. Replay discovers it. No atomic-batch/rollback promise. Whole-input grammar rejection throws before starting, not a fake index0 result. No partial durable results are silently discarded merely because a later item failed. Once admitted into the serialized batch, item-level errors return stopped. Safe/unknown exceptions MUST first propagate through the shared serial error boundary; only its outside rejection handler converts them into the prefix result. Do not catch and return normally inside serial, which would bypass operation-wide poisoning. A safe validation exception after an earlier attempted row conservatively poisons under the existing owner rule, preserving its safe code. A known conflict returned normally does not poison because it is not an ambiguous write. A first before_write hook exception with no attempted row leaves owner usable and returns stopped with results:[] and invalid_request. Pre-admission owner-unavailable/closing/poisoned refusal throws the existing owner error because no item was entered. Whole-request syntax validation happens before queue admission, as explicitly required.

Before acknowledging each append: refresh, resolve by scoped public_id AND sourced tuple if present AND (W,session,seq) AND global id; each must identify exactly one same full expected row. Compare every physical field, not just encoder validity. Unknown failure after an attempted SDK write poisons the owner and yields recovery_required for that item; no subsequent queued mutation. Safe actual class errors retain existing envelope but still poison post-write. Hook-thrown objects are not authority. No rollback/delete/repair of ambiguous state. Fresh gated owner can retry by stable identity.

## 6. Existing errors, reads, limits
The stop union is CLOSED: null, {index,error}, or {index,conflict}; no variant carries both. conflict values exactly public_id or source_payload. An alternate proposed public_id occupied by another row yields public_id. stop.error is the exact safe toJSON() envelope after permitted path anchoring, including version/code/path/message. Item-local paths use /items/i and must agree with stop.index; root-state errors keep empty path, index stays alongside, not injected into it.

No third error envelope: preserve governed ContractError/arra-error/v1 for parsing, value and accepted replay scope_mismatch, with paths anchored to actual request. Persistence/reference/state failures reuse PublicationError/arra-publication-error/v1 unchanged (historical version name is deliberate reuse, not a claim this method publishes knowledge). Permitted PublicationError codes are exactly invalid_request, invalid_reference, integrity_failure, writer_unavailable, unsupported_dataset, recovery_required, limit_exceeded. not_found is excluded (its fixed message is node-specific); reads return null for absent scoped identity. invalid_reference for missing request references; integrity_failure for malformed/duplicate stored state, root path; limit_exceeded for bounded walks/scans, root. Request paths use /items/i/... for item-local refs; workspace/session use outer pointers. Unknown SDK text never exposed. The outer stop serializer accepts only actual ContractError or PublicationError instances; forged name/code objects are unknown and normalize to fixed recovery_required. Unknown pre-write storage failure returns that safe error without inventing an attempted write or poisoning; unknown post-write failure is first classified/poisoned by serial. Taxonomy errors are not part of the context method error union. Full name/version/code/path tests are mandatory.

Precedence: complete syntax/shape/value checks, workspace, session, item identity uniqueness/stored integrity, requested refs/policy, replay scope/digest or public-ID comparison, allocation, write/readback. Stored matching source's destination mismatch remains above payload mismatch. Read methods refresh latest state each call, scope all predicates; get returns row/null; list returns exactly {rows:[MessageRow],next_after_seq:I|null}. Use scoped keyset predicate seq>after_seq (no offset), ascending Int64 ordering then limit+1 to detect continuation; validate uniqueness of every emitted (W,session,seq) and public_id. Emit at most limit rows; if an additional row exists next_after_seq is the last emitted sequence, else null. Empty page has rows:[] and null cursor. Sort compares exact Int64, never JS Number. Read physical rows only after bounded identity selection; get returns the literal row/null without wrapper. Result-row arrays (list rows and batch results[].row) have a cumulative16MiB JSON UTF-8 budget including array brackets/commas, not outer envelopes; over-budget fails limit_exceeded, never silent truncation. No SDK peak-memory guarantee is implied by this wire budget. A row already appended is visible, not proof a caller received ACK. Read snapshots are per-call, not a cross-call transaction. Released owner reads recovery_required; poisoned owner reads allowed. Wire every Message column in target physical order: Int64 decimal strings, exact UTC milliseconds after raw remainder check, JSON columns retained strings, nulls explicit. Legacy sub-ms rows fail closed here, not silently normalized or deleted; lossless export is separate #8/#34 work.

## 7. Seams and independent proof
Context boundaries per NEW row: before_write -> after_write -> after_readback. No boundary for replay/read; attempted flag immediately before SDK call; previous attempted row makes later hook failure poison. Seed registration writes use same triples. Hooks carry only literal boundary names (count occurrences); no raw adapter. Parent-driven kill/reap/monotonic deadlines with stderr drainage; actual SDK failure must be repaired BEFORE same-owner second request to isolate fail-stop.

Independent tests: local and sourced lost-ACK replay with no allocation/time drift; cross-destination scope mismatch; changed payload conflict; item0 accepted/item1 fails/item2 unattempted; post-write ambiguous row discovered by fresh owner; exact error envelopes and prewrite-useful/postwrite-poisoned controls; uniqueness/gaps/Int64 ceilings/negative retained legacy values; parent chain bounds/cycles; cross-factory shared queue/poison/close and unchanged legacy factory shapes. Existing codec fixtures, publication/taxonomy and isolation guards remain regression gates.

## 8. Exact additional rules

- Context writer has exactly these eight methods: registerPeer, registerSession, joinSession, appendMessages, getPeer, getSession, getMessage, listMessages. Context reader has exactly the last four. Factory options require sourceNamespace (explicit null allowed) and retain KnowledgeOptions/newRevisionId; context operations do not call the revision-ID allocator. Invalid configured namespace rejects before opening a connection. It is not an authorization credential; only trusted adapter configuration may select it.
- Stored rows use literal physical field order from target_v1/core.py, all fields present. Peer/Session/SessionPeer timestamps decode raw Int64 microseconds before Number; require exact millisecond divisibility and supported Gregorian range. IDs/names/scopes must satisfy stated grammar, flags Boolean, optional JSON columns valid-Unicode strings or null retained byte-for-byte (this slice does not parse or recanonicalize their JSON contents), nullable times/nulls preserved. Message id/seq/token_count decode exact signed Int64 strings; token_count must be >=0. read is Boolean|null. role/content use governed grammar. Validate stored source presence and recompute sourced digest from stored envelope. Structural/stored-digest failure is integrity_failure root, never a request-shape error.
- Local replay compares destination first, then peer_name/content/role/in_reply_to and local source-null mode exactly. Sourced replay uses existing classifier over its recomputed digest and destination. Both validate retained allocated fields and current scoped refs; do not compare retained timestamps to a retry clock. Stored mutable read/read_at/metadata and token_count are retained rather than reset; their structural validity still required. Existing source identity cannot be replaced by a local request, nor a local row adopted into a sourced identity.
- Sourced precedence: look up source tuple (W,namespace,source_message_id) and scoped proposed public_id, reject duplicates/malformed rows; if source exists check destination first, then proposed-ID collision (different row -> public_id), then payload classification. If source absent but proposed-ID exists, public_id conflict. If both identify same row, proceed. A different unoccupied proposal on source replay is ignored and original ID returned. Local wrong destination uses /items/i/existing/session_name; sourced wrapper paths re-anchor beneath /items/i, even though existing is service-observed rather than caller input. Common field/digest errors retain their actual input pointer with item prefix.
- Whole-input parser/closed-key/type/format rules precede queue admission; request semantic validation of source mode/supplied digest and foreign refs is per item so it can produce a durable-prefix stop. Do not sample clock to decide a replay. To reuse prepareNewMessage for per-item mode/digest validation before knowing new-vs-replay, construct its trusted context with fixed canonical intake `1970-01-01T00:00:00.000Z`; discard those derived time fields. For a NEW item only, sample validated clock and invoke prepareNewMessage with that intake for the actual row. Never persist sentinel-derived times accidentally; clock sentinel-positive and replay-no-clock tests required. The seven-field digest excludes intake, so both passes must agree on digest. No copied message canonicalizer.
- Missing request refs and inactive session/membership are invalid_reference at their request pointers. Context get/list reads do not require active status but do require unique existing workspace; missing workspace invalid_reference/workspace_name, duplicate root integrity. Missing get target returns null; list missing session invalid_reference/session_name. A found message whose stored peer/session/membership is missing or structurally inconsistent fails integrity; retired/left status by itself does not erase readable history. New/replayed appends require CURRENT active membership as already stated, so a historical replay after leaving is refused, never deletes history.
- Reply lookup missing/wrong session is invalid_reference at /items/i/message/in_reply_to. Self link is invalid_request there. Existing ancestor missing/cross-scope/cycle/invalid sequence order is integrity_failure root; exceeding1024 visited is limit_exceeded root. For replay, reply predecessor sequence must be strictly below retained message seq; for new append below selected new seq. No automatic session traversal.
- Before a NEW item writes, equality checks ensure proposed allocation keys vacant. Returned selected maximum must be Int64 and unique on its allocation key. No validation claim about untouched non-extremal historical keys. Session pagination validates emitted rows plus selected lookahead key, and equality-checks every selected sequence/public ID; duplicate selected keys fail rather than split across pages. Counts/returned-row limits: max-query1, equality-query2 to discriminate duplicates, list key query<=101. No full-table JS materialization, offset pagination, timestamp cursor, or Number sorting.
- get/list array payload wire budget16MiB is a response bound, not Arrow allocation/RSS guarantee. For get a single encoded row >16MiB rejects limit_exceeded. For append results, account each encoded row before adding its acknowledged result; known-valid new input totals are bounded by1MiB request cap but replay metadata may exceed response budget. A replay row exceeding remaining budget stops at that index without a new write; prior attempted-write behavior follows serial as usual. No truncated result row.
- Conflict reasons for registration are as section5; same-ID/different-name uses id, name held by different ID uses name, left membership uses membership. If both identity and name claims collide, ID disagreement takes precedence after integrity checks. joinSession missing/inactive session /session_name, missing peer /peer_name. Name-bearing get shapes have no speculative ID alias. Global error paths stay empty.
- Registration boundary hooks use one triple per actually appended row. A first pre-write hook error is invalid_request and unpoisoned; any prior attempted write within the operation makes later hook failure recovery_required and poisoned. Registration readback verifies unique scoped ID/name or membership triple and full expected row. Exact replay emits no hook and consumes no clock. Each appendMessages call holds the write queue until completion or stopped result; outside handler builds that result before returning to the caller, but queue/poison classification already happened.

## 9. Files, owners, regression boundaries

Base `55ab093af0f28b5f57f41c38b126cd870854f696`. Use fresh named worktrees/branches; preserve all old trees and .serena. No source edits outside these paths. Root owns this document and integration/acceptance manifests.

CORE (neo, sole writer of shared service):
- app/server/src/publication/service.ts — context factories/facade, private ordered projection method, shared owner wiring; preserve existing factory semantics.
- app/server/src/publication/context.ts — new pure grammar/physical encoder, no SDK/connection/table/owner authority.
- app/server/src/publication/storage.ts — only refactor existing raw Arrow decoding into a reused decoder accepting an already obtained Arrow table, plus exact field-description support if needed; rawRows behavior unchanged. No connection opener/owner constructor, no lossy Number fallback introduced, no broad formatting. New pure decoding export carries data, not authority.
- app/server/test/context-service.test.ts
- app/server/test/helpers/context-fixture.ts — wrap existing frozen bare taxonomy fixture and existing bounded publication child helpers; no second Python creator or unbounded child launch.
- app/server/test/fixtures/context-v1/core/**
- app/migrate-py/tests/test_revision_v1.py — IsolationTests only, exact context module exemptions/import pattern and matching sensitivity sample. No directory exemption, no protected codec change.

OWNERSHIP (v4-ownership):
- app/server/test/context-ownership.test.ts
- app/server/test/fixtures/context-v1/ownership/**
- app/server/test/taxonomy-ownership.test.ts — ONLY exact export-list amendment from5to7, equality+capability prohibition retained. Apply when new factories synced; no other expectation edits.
Independent scope: registration/scoped refs, local/sourced collision and destination precedence, current inactive/membership policy, read history, shared queue/poison directions/close, surface exactness. Core may have basic controls but do not duplicate this entire oracle.

RECOVERY (v4-recovery):
- app/server/test/context-recovery.test.ts
- app/server/test/fixtures/context-v1/recovery/**
Independent scope: durable prefix, local/sourced lost ACK, readback corruption, actual SDK failure with repair-before-second, first prewrite usable versus post-prefix safe-error poison versus known-conflict usable, exact error envelopes and bounded parent deadlines. Independent expected identities, not builders defining their own assertions.

PRECISION/ORDER (v4-fixtures):
- app/server/test/fixtures/context-v1/precision.test.ts
- app/server/test/fixtures/context-v1/precision/**
Independent scope: ordered allocation with negatives/beyond2^53/Int64 ceilings, exact timestamp/BigInt wire/Arrow values, sub-ms refusal, keyset pagination with distractors/gaps, selected duplicate detection and no global-integrity overclaim,1024/1025 reply ancestry, response-bound exact/+1 where constructible. Disposable gated raw fixture preparation only, no service/helper/exporter edits. No live external data/model/network.

Before sharing source, core publishes helper signatures early and marks absent APIs as absent. Helpers sync only root-approved exact files/hashes. Frozen existing #26/#27 tests and codec files unchanged except the two explicit exceptions above. Tests assert full error name/version/code/path, measured child exit status, actual persisted state and no-write snapshots. No green acceptance from skips. Final root full-run includes existing Python99+publication17+taxonomy22, all Bun files including nested precision suites, typecheck/build/changed-Python lint/isolation/source stability. Floors rechecked from discovery; counts alone do not prove case coverage.

## 10. Stop conditions and limits
Report actual failures before changing any expectation; source repairs serialized under core. No commit/push/PR until exact-hash acceptance packaging dispatch. Do not close parent28 from this slice. Keep process-death/SDK-failure distinct from power loss; cooperative gate distinct from CAS or hostile-same-UID protection. No authorized ordinary-user path or deployment is claimed. Dataset-size and engine-work performance are separate future measured optimization, never approximated correctness.

## Amendment 2026-09-26 (overnight R3)

Appended, not rewritten: the frozen text above stands except where this section says
otherwise. Authority: `docs/overnight/DECISIONS.md` R3, which applies the Codex design
lead's closed decision of 2026-09-21 ("membership becomes a real read boundary on
listMessages/getMessage"). Issue #87.

**What changes.** Session membership is now a read boundary on `getMessage` and
`listMessages`, not only a write rule and a `getContext` filter. Before this amendment
any `content:read` holder read every message of every session in the workspace, while
`getContext` refused the same content to a non-member; that split looked like a
membership guarantee and was not one.

**Grammar (§2).** Both reads accept one OPTIONAL key:

```text
getMessage   {workspace_name:W, public_id:N [, requester_peer_name:S|null]}
listMessages {workspace_name:W, session_name:S, after_seq:I|null, limit:number [, requester_peer_name:S|null]}
```

`requester_peer_name` is the only optional key in this grammar. Omitted and `null` both
mean "no requester". A present non-null value uses the S grammar (nonempty valid Unicode,
at most 256 UTF-8 bytes, no normalization) and fails at `/requester_peer_name`. Every other
key stays required, and unknown keys still reject: `peer_name` is not an alias. Optional
rather than required-nullable because every existing caller (UI v2, the dev stack, the
acceptor probe) omits it and reads through the operator view below.

**Authority argument.** The facade methods become `getMessage(bytes, authority)` and
`listMessages(bytes, authority)`. `authority` is `RequestAuthority {operator: boolean,
peers: readonly S[] | null}`, built by the transport only from the policy snapshot that
admitted the request, never from request bytes:

- `operator` is true when the admitted principal also holds `audit:read` on the route
  workspace. HTTP decides this with a second `admit` on the same snapshot and clock; MCP
  reads it from the four-action projection.
- `peers` is the admitting grant's arra-auth/v1 binding (authorization-v1.md, amendment of
  this date), or null.

A missing or malformed authority is a wiring fault: a plain `TypeError`, nothing read.

**Precedence (§6, reads).**

1. Grammar.
2. Authority, before any storage read:
   - no requester and not `operator` gives `forbidden` at `/requester_peer_name`;
   - a requester outside a non-null `peers` gives `forbidden` at `/requester_peer_name`.
3. Workspace, as before.
4. `listMessages` checks the session (`invalid_reference` `/session_name`), then the
   requester's CURRENT membership through `requireCurrentMembership`, the same check
   `getContext` applies: the peer must exist and its membership row must exist with
   `left_at` null. Otherwise `invalid_reference` at `/requester_peer_name`. Then the page,
   as before. Session existence is already visible to `content:read` through
   `listSessions`, so this refusal reveals nothing new.
5. `getMessage` looks up the scoped `public_id`. Absent returns null, as before. With a
   requester, it checks CURRENT membership of the row's own session. A stranger, a
   departed member or a nonexistent peer reads null, identical to an absent id, so a
   non-member cannot learn that an id exists (authorization-v1.md §3: "Missing and
   inaccessible references must not expose existence").
   Membership is decided on the stored row's raw `session_name` BEFORE the row's own
   integrity check. So a corrupt message reports `integrity_failure` to whoever may
   read it (a current member, the operator view), and a non-member still reads null.
   Two residuals remain, both needing corrupt storage:
   - a row whose `session_name` is not a string at all fails integrity first, because
     no membership can be decided for it;
   - `requireCurrentMembership` still reports a corrupt row of the requester's OWN peer
     or membership record.

A named requester narrows the operator view too: `operator` with a requester reads as that
requester.

**New error code.** `arra-publication-error/v1` gains exactly one code, `forbidden`
(fixed message `request not permitted for this caller`), mapped to HTTP 403. §6's
permitted-code list grows by this one code for `getMessage`/`listMessages`. No other
context kernel throws it; the transport peer-binding check may return it for any method
with declared acting-peer fields (authorization-v1.md amendment).

**§8 history clause.** "Retired/left status by itself does not erase readable history"
still holds for storage and for the operator view. It no longer holds for the departed
member itself: as requester it reads nothing, which matches the append rule.

**Transports.** HTTP `POST /api/knowledge/:bank/{getMessage,listMessages}` and MCP
`kb_getMessage`/`kb_listMessages` pass the authority through the registry. The MCP tool
descriptions and payload schema document `requester_peer_name` and the `audit:read`
operator view.

**Evidence.**

- `app/server/test/context-read-boundary.test.ts`: service level, real gated dataset. It
  includes a corrupted stored message, staged with `raw-mutate.ts corrupt-message`.
- `app/server/test/transport-read-boundary.test.ts`: live `createApp`, HTTP and MCP.

Both were seen red before the change. The corrupt-message case was added in a fix round,
also red first: before it, a non-member got `integrity_failure` for a corrupt existing id
and null for an absent one.

## Amendment 2026-09-26 (overnight R18 (V4 + K12a + K9-K11, D7, D8))

Appended, not rewritten: the frozen text above and the R3 amendment stand except where this
section says otherwise. Authority: `docs/overnight/DECISIONS.md` R18 (D7 accepts `closeSession`
as a one-way close recorded in `sessions.internal_metadata`, with no new column; D8 makes
`X-Arra-Peer` the connection-level speaker, bound by R3 `peers:[...]`) and the kernel table of
`docs/overnight/V3-PARITY.md` §5 (K9-K12). Issues #31 (the v3 forum adapter needs these reads and
the close) and #28. Nat's intent for the forum family: each oracle registers as a peer and they
talk to each other like a Claude Code channel. A thread is a session, a post is a message.

**Why.** The v3-compatible forum tools could not be served honestly without four things the
frozen interface lacked: a thread title with nowhere to live (§2 "JSON columns are initialized
null"), no way to close a session (§3 "never reactivation" covered only the other direction),
no read of `session_peers` at all, and no way to read "the last N" messages without walking the
session from the start. None of the four adds a table, a column or a dependency.

**K12a, `registerSession` display title (§2, §3).** One OPTIONAL key, on the same terms as R3's
`requester_peer_name` (every existing caller omits it, and omission already has a meaning):

```text
registerSession {workspace_name:W, session_id:N, name:S [, h_metadata: null | {title:T}]}
```

`T` is a nonempty valid-Unicode string of at most 1024 UTF-8 bytes (a chosen wire cap). The
object is closed: exactly `title`. Omitted and `null` both store `h_metadata = null`, as before.
A present title is stored as the canonical (RFC 8785) text `{"title":T}`. It is DISPLAY data:
the name stays the immutable identity (DESIGN.md:369), and a title is never matched on. A replay
under the same id and name is `already_satisfied` and retains the ORIGINAL row, title included,
exactly as §3 already says of "all current optional metadata". `appendMessages` still writes
`h_metadata = null` (K12b, a per-message model, is not part of this amendment).

**K9, `closeSession` (new write, `content:write`).**

```text
closeSession {workspace_name:W, session_name:S, reason:R, peer_name:S|null, operation_id:O}
```

`R` is nonempty and not only whitespace (the record exists to say why; a reason with text is stored
exactly as sent, untrimmed), at most 4096 UTF-8 bytes (the lifecycle reason cap). `O` is a nonempty
string, deliberately not nanoid-shaped like lifecycle operation ids, but at most 256 UTF-8 bytes (the
name cap), because it is stored inside the session row rather than in a journal. All keys required,
closed.

- Effect: `is_active` true -> false, ONE WAY, and `internal_metadata` becomes the canonical JSON of
  every key already stored there plus `closed: {at, by_peer, operation_id, reason}`. `at` is the
  injected clock rendered as exact UTC milliseconds; `by_peer` is `peer_name`. Nothing ever sets
  a session active again: registration stays `already_satisfied` on an inactive session.
- Result: `{outcome:"closed"|"idempotent", row}` or `{outcome:"conflict",
  reason:"operation_digest"|"already_closed", row}`, where `row` is the stored session row. No
  new error code; conflicts are values, as §5 already does for registration.
- Authority (R3 terms, before the queue, after grammar): the method takes the transport-built
  authority, as `listMessages` does. A non-null `peer_name` must sit inside the grant's `peers`
  binding when one exists (the transport checks it; the kernel re-checks it), else `forbidden
  /peer_name`. A `null` `peer_name` is the OPERATOR path: it needs `audit:read` on the workspace,
  else `forbidden /peer_name`. A missing authority is a wiring fault and fails closed.
- Precedence: grammar and authority (before the queue), workspace (`invalid_reference /workspace_name`),
  session (`invalid_reference /session_name`), stored integrity, replay, state, reference, clock,
  write. Replay: a stored close record with the same `operation_id` is `idempotent` when reason
  and peer match and `operation_digest` otherwise; no clock is sampled and no boundary fires.
  State: any other close of an inactive session is `already_closed`, nothing written. Reference:
  a non-null `peer_name` must exist and hold CURRENT membership of the session
  (`requireCurrentMembership`), else `invalid_reference /peer_name`. `null` (the operator path
  above) is recorded as `by_peer: null`.
- Stored integrity: `internal_metadata` that is not a JSON object, a `closed` value that is not
  exactly `{at, by_peer, operation_id, reason}` with an exact-millisecond `at`, or an ACTIVE
  session carrying a close record, is `integrity_failure` at the root, never repaired.
- Write: one guarded update (`is_active = true` and the `internal_metadata` that was read), one
  boundary triple, readback of every physical field. Anything but exactly one updated row, or a
  differing readback, poisons the owner and answers `recovery_required`, as §5 requires.
- `operation_id` is the retry key of THIS session's close. It is recorded on the session, not in
  a workspace-wide journal, so reuse across sessions is not detected.
- Consequences already in the frozen text: a closed session refuses `appendMessages` (stopped,
  `invalid_reference /session_name`) and `joinSession` (`invalid_reference /session_name`), and
  stays readable history through every read.

**K10, session filters and the first membership read (new read, `content:read`).**

```text
listSessions       {workspace_name:W, after_name:S|null, limit:number, include_total:boolean
                    [, is_active:boolean|null] [, member_peer_name:S|null]}
listSessionMembers {workspace_name:W, session_name:S, after_name:S|null, limit:number
                    [, requester_peer_name:S|null]}
```

- `is_active` filters inside the page query and the count, so pages are full and `total` counts
  the filtered set.
- `member_peer_name` lists only sessions the peer CURRENTLY belongs to (`left_at` null), keyset
  over its memberships by session name, each batch's sessions fetched in one query. With
  `is_active` as well, batches continue until the page fills, the memberships end, or 1000 are
  scanned; a page cut by that bound may be short with a non-null `next_after_name`, which is an
  exact keyset position. `include_total:true` with BOTH filters is refused (`invalid_value
  /include_total`): it would need an unbounded join, and a total is never approximated. An
  unknown peer is an empty list, not an error: it is a filter, not a reference.
- `listSessionMembers` answers `{rows:[SessionPeerRow], next_after_name}` ordered by peer name,
  departed members included with `left_at` set. Missing session is `invalid_reference
  /session_name`. It is `content:read`, behind the SAME R3 boundary as `listMessages`, on the
  same terms: the OPTIONAL `requester_peer_name` must sit inside the binding and hold CURRENT
  membership (else `forbidden` / `invalid_reference /requester_peer_name`, checked after the
  session exists); omitted or `null` is the `audit:read` operator view, else `forbidden
  /requester_peer_name`. Who belongs to a session is who talks to whom.
- Peer binding (authorization-v1.md, R3): `listSessions.member_peer_name`,
  `listSessionMembers.requester_peer_name` and `closeSession.peer_name` are caller-asserted peers
  (`knowledge/registry.peerFields.ts`), so a credential bound to `peers:[...]` may ask only about,
  list the members of a session only as, and close only as, a bound peer.

**K11, `listMessages` tail (§6).** Two more OPTIONAL keys:

```text
listMessages {... [, direction:"asc"|"desc"] [, before_seq:I|null]}
```

Omitted `direction` is `"asc"`, the frozen read, answering `{rows, next_after_seq}` unchanged.
`"desc"` reads newest first with the exclusive keyset `seq_in_session < before_seq` (null starts
at the newest) and answers `{rows, next_before_seq}`. One cursor per direction: `before_seq` with
`asc`, or a non-null `after_seq` with `desc`, is `invalid_value` at that key. The R3 read boundary,
the validation of every selected key and lookahead, and the 16 MiB budget are identical for both
directions (one shared `selectMessagePage`).

**§8 surface.** The context writer gains `closeSession`; both reader and writer gain
`listSessionMembers`. The registry (`knowledge/registry.ts`) exposes both over HTTP, MCP (`kb_*`)
and the CLI (`kb <method>`); `closeSession` is `content:write`.

**Fix round (same amendment, before merge).** An independent verification of this slice showed
two holes these rules now close. (1) `closeSession` with `peer_name:null` let a credential bound to
one peer close, one way, a session none of its peers belonged to: `null` asserted no peer, so the
binding judged nothing. It now needs `audit:read`, the same rule R3 gives a message read that
names no requester. This is stricter than `retireNode`'s null `peer_name` (unchanged, outside this
amendment); a close is permanent and hides a whole conversation from new posts. (2) The binding on
`listSessions.member_peer_name` had no effect while `listSessionMembers` listed any session's
members to any `content:read` holder; the member list is now behind the R3 boundary above.
`closeSession` also gained the nonblank-reason and 256-byte `operation_id` bounds stated above.

**Not in this amendment.** `listSessions` ordering by creation or activity (`order:
"created_desc"`, V3-PARITY §5 K10) is not built: `created_at` is not unique, and a safe keyset
over it needs a composite cursor the ordered projection does not provide. Per-message `model`
(K12b) and a per-session message count are not built.

**Evidence** (each seen red before the change):

- `app/server/test/context-session-close.test.ts`: K12a and K9 at the service level, real gated
  dataset, including a reason with a quote, a backslash and Thai text round-tripping through the
  guarded update, and stored metadata staged with `raw-mutate.ts session-internal-metadata`.
- `app/server/test/context-session-reads.test.ts`: K10 and K11, including a departed member and
  the R3 boundary on the tail.
- `app/server/test/mcp-v3-forum.test.ts`: the four v3 forum tools over the real wire, inside the
  writer gate.
- Fix round, each red first: the null-peer close refused without `audit:read` (kernel and
  `kb_closeSession`), the kernel's own re-check of the binding, the grammar bounds, and
  `listSessionMembers` refusing a stranger, a departed member, an unbound requester and a
  peerless non-operator (kernel and `kb_listSessionMembers`).
