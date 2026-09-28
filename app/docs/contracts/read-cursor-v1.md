# Workspace-safe persisted read cursors v1

Status: FROZEN IMPLEMENTATION CONTRACT — 2026-09-21. Root-owned. Implementation requires the separate matching-SHA/base/worktree/ownership dispatch.
Parent #28. Base accepted main `d42ee3e9ef563547ceca128e0d1719bf3386ef56` (association PR70). This is authoritative per-reader progress, not a derived projection, not closure of session links/traces/source-adapter/permission-scoped expansion work. No live dataset has been inspected; no claim retained cursor rows are absent or compatible is made.

## 1. Authority and exact composition amendment
Add getReadCursor to each context reader/writer facade and advanceReadCursor to each context writer facade, including the context facade composed by evidence factories. No new factory, runtime export, bundle key, close method, schema, dependency, transport or permission authority. The service runtime export set remains the accepted nine. Publication/taxonomy/evidence method lists are unchanged. Explicitly amend the context-ingestion-v1 section8 eight/four method counts to ten/five, and association-evidence-v1 unchanged-context-facade promise only by these two methods; do not reinterpret any existing method. These overrides are normative in THIS new contract only; accepted historical contract files remain byte-frozen and are not edited.

Use the same owner registry, serial queue, attempted-write/poison boundary and one-shot close. Cursor reads bypass the queue, survive poison and fail recovery_required after bundle release. Cursor writes require the real inherited local writer gate. Names in requests are not authorization; #25/#31 admission must bind the actual reader before transport activation. This interface does not grant another peer's visibility merely because its name is known.

Use the accepted strict raw UTF-8 parser/common validators and message encoder without changing them. Pure cursor grammar/row encoder belongs in publication/read-cursor.ts, no SDK/connection/owner import. Private service wiring reuses existing query/refresh/append/updateWhere; no new adapter capability. No schema or provenance rewrite, no deletion/reset, no mutation of messages.read/read_at, and no read-driven cursor writes.

## 2. Closed requests and results
All object keys required; explicit nulls only. Raw Uint8Array JSON at most1MiB/depth64 with accepted duplicate-key/Unicode validation. W, peer and session names are valid Unicode, nonempty, <=256 UTF-8 bytes, exact/no normalization. N is the accepted nanoid21 grammar. No legacy numeric alias or alternate raw identity key.

getReadCursor {workspace_name:W,peer_name:S,session_name:S}
advanceReadCursor {workspace_name:W,peer_name:S,session_name:S,last_read_message_id:N,expected:null|{last_read_message_id:N|null}}

expected:null means absent ROW. expected:{last_read_message_id:null} means a present row with a null POINTER and a real nonnull last_read_at. These are distinct prior states. No nullable desired position: service creates a row only when a real message is marked read. Retained null-pointer rows remain readable and advanceable; this slice never creates them itself.

get returns the literal row or null. Successful write response is {outcome:"created"|"advanced"|"already_satisfied",row}. Conflict is the returned value {outcome:"conflict",reason:"expected"|"backward",row:<current row|null>}. Every variant is closed; conflict is not a thrown error and never poisons. row:null occurs only for expected mismatch against absence. Row fields appear in exact physical order: workspace_name,peer_name,session_name,last_read_message_id,last_read_at. Timestamp is exact UTC-millisecond text, nullable pointer explicit. No seq or extra identity is silently persisted; seq is read from the referenced message for comparison.

## 3. Identity, references, retained-state compatibility
Logical cursor key is (W,peer_name,session_name); equality query limit2 discriminates0/1/>1. Duplicate cursor key is integrity_failure at root on reads AND writes, never pick or repair one. Resolve unique existing workspace, peer and session in that order. Missing request references are invalid_reference at /workspace_name, /peer_name, /session_name; duplicates or malformed retained rows integrity_failure root. Peer/session structures use accepted full encoders. Inactive session and departed membership DO NOT forbid reading or recording progress in retained history. No membership row is required for the observing peer; no rejoin/reactivation is performed. This deliberate policy differs from appendMessages, whose current-active-membership rule remains unchanged.

The declared namespace for this NEW service is message.public_id. Physical last_read_message_id stores that handle, not decimal legacy message.id. Resolve only (W,public_id); never try message.id as a fallback, even to classify. Literal "42" in a request fails governed static nanoid grammar. Retained nonnull pointer must itself satisfy N; malformed or unresolved retained pointer is integrity_failure root. Incompatible/orphan retained pointers are terminal THROUGH THIS INTERFACE until a separately reviewed migration/repair exists. This does not authorize conversion or claim compatibility with any uninspected retained dataset/Honcho convention.

For a request desired pointer: select unique message by (W,public_id), validate full stored row using encodeMessageRow (including stored sourced digest recomputation), then require session_name equal to requested session. Missing/wrong-session desired message is invalid_reference at /last_read_message_id. Retained cursor pointer resolving missing/wrong-session message is integrity_failure root. Validate each selected message's exact signed Int64 seq_in_session and require equality lookup on (W,session_name,seq_in_session) selects exactly ONE SAME message row. Duplicate public_id or selected sequence is integrity_failure. Only selected identities are checked; no whole-corpus audit, global max or allocation scan. Message content/reply ancestry is not traversed by the cursor operation. No new reply, source or author mutation occurs.

Stored cursor row must have all five columns: exact scoped names, N|null pointer, raw Int64 microsecond last_read_at divisible by1000 and within Gregorian0001..9999 before rendering. Null timestamp, sub-ms remainder, invalid Unicode/name, missing field or bad type is integrity_failure root, not coercion. No rounding, Date-range extension or lossy Number path. Pure encoder tests must reject malformed/null timestamp inputs regardless of whether the physical engine admits them; NOT NULL schema declarations alone are not measured engine-enforcement evidence. Structural validation and retained-pointer checks still run for already_satisfied and conflicts.

## 4. Ordered decision and clock rules
Static grammar precedes owner/queue admission. Inside one serialized write: resolve W/peer/session, select and fully validate current cursor (including its referenced message if nonnull), resolve/validate desired message and selected-sequence uniqueness. Stored corruption precedes ordinary conflict decisions.

1. If current pointer equals desired public_id: already_satisfied, retained row/timestamp, no expected comparison, no clock, no mutation/hook.
2. If current pointer is nonnull and desired seq is LOWER than current seq: conflict/backward, no clock/mutation/hook. Signed BigInt ordering only, including negative retained positions, gaps and values beyond2^53. No lexical/Number/timestamp ordering or zero clamp. Equal selected seq with different IDs is already rejected by section3 uniqueness validation, never classified as already_satisfied.
3. Otherwise compare expected to the exact current pointer-state (absent vs null vs N). Mismatch: conflict/expected with retained current row/null, no clock/mutation/hook. Expected N need not be dereferenced: it is an old VALUE guard, not a request to read that message.
4. Only a real creation/advance samples options.clock once. It must return a finite safe integer milliseconds in Gregorian0001..9999. For an existing row, compare BigInt(clockMs)*1000n >= retained raw last_read_at microseconds; equality is allowed. Never compare milliseconds directly with microseconds. Regression/invalid clock is PublicationError invalid_request at ROOT and writes nothing. The clock is operator/environment configuration, not a blamed caller field.
5. Build the full physical target row, then write and verify as section5.

Expected guards ONLY a mutating path. If two callers desire the same P with stale expected E, the first may advance and the second returns already_satisfied with the first timestamp: progress is idempotent, not proof of which operation wrote it. Timestamp is observed output, not an operation ID or expected input. A retry after a landed write is clock-free; a retry after interruption BEFORE any write may be blocked by clock regression until the environment is corrected. No unconditional progress guarantee under broken operator clock. No reset or backwards operation in this slice. A valid but future-dated retained timestamp blocks advancement until the operator clock reaches it; this interface does not reset that timestamp.

## 5. Persistence and recovery
One cursor call holds the shared queue. Before any persistence, fully validate/build the target row; no conversion may occur only after marking attempted. Use accepted context boundary hook names, one triple per actual cursor mutation: before_write -> after_write -> after_readback. No new hook option, no hooks for reads/replays/conflicts. First before_write hook refusal is invalid_request root, owner usable. Immediately before append/update mark attempted; any later safe exception preserves its actual class while poisoning; unknown SDK/ambiguity becomes recovery_required. Exceptions must escape the shared serial boundary; no catch-and-return bypass.

Absent creation appends one complete row. Existing advancement uses updateWhere with fixed escaped logical-key predicate AND expected previous pointer (IS NULL or exact quoted public_id). Assign only desired pointer and exact timestamp via accepted BigInt-microsecond TIMESTAMP(6) cast. The existing adapter mapping an absent/non-number rowsUpdated to0 remains fail-closed: it is not a reliable acknowledgment and must not become success. No adapter change is required to distinguish it from a true zero. rowsUpdated must be exactly1; otherwise recovery_required and poison, not an expected conflict after a write attempt. Cooperative gate+queue is the exclusion mechanism, NOT store CAS, a lease or hostile-same-UID protection. Pointer-only expected guards retain the usual expected-VALUE/ABA limitation; no history or timestamp guard is implied.

After successful SDK call and after_write hook: refresh read_cursors, require unique logical key and full five-field equality with the built target. Re-resolve desired message identity/session/selected sequence and ensure it still matches the chosen identity/seq. A duplicate or malformed retained row detected during this readback is integrity_failure at root AND poisons the owner. Missing expected cursor or a well-formed unexpected field/identity value is recovery_required AND poison. Unknown SDK failure is recovery_required; preserve any actual governed safe exception as above. Only then after_readback hook and acknowledgment. No rollback/delete/repair. A killed writer may leave either prior state or desired state; fresh owner retries with same desired/expected, either advancing from prior state or returning retained already_satisfied. Corrupt/duplicate/third-party state is never adopted as successful recovery. Convergence is conditional on the retained state still being prior or desired, valid references and a valid non-regressed clock when a write is needed. A later legitimate advance can make an old retry conflict; no unconditional retry-progress guarantee is claimed.

A real retained-null-pointer advancement test must exercise the composed IS NULL guard plus TIMESTAMP(6) assignment and readback; separate accepted uses of each primitive are feasibility evidence, not a measurement of that exact statement. No speculative fallback if the SDK rejects it.

No multi-table transaction is claimed. Messages are immutable under this accepted service and cursor writes touch only read_cursors. Reader sees a valid retained row at the call's reads, not a snapshot across calls. Writer readback covers exactly its selected state, not unrelated corpus rows.

## 6. Errors and bounds
Reuse governed ContractError for raw grammar with actual code/path/message; reuse arra-publication-error/v1 permitted codes invalid_request, invalid_reference, integrity_failure, writer_unavailable, unsupported_dataset, recovery_required, limit_exceeded. not_found excluded. Missing cursor is null, not error. No third envelope or custom message. Actual thrown instance has name; toJSON has exactly version/code/path/message and no name. PublicationError fixed literals must be asserted exactly. Governed deterministic fixture errors assert the actual accepted call-site code/path/message as a closed object, never invented replacement text. Where parser text is intentionally unconstrained, nonempty-message checks must disclose that narrower coverage; they do not prove message identity.

Cursor lookup and each reference/sequence lookup max2 rows. No enumeration, ordering/max query, graph walk, offset, timestamp pagination or full-table JS scan. Return complete row/null/closed result; maximum response16MiB total JSON UTF-8, equality allowed, though valid five-field rows are much smaller. This bounds wire/materialization selection, not SDK engine work or RSS. No claims of detecting corruption outside selected cursor/message keys.

## 7. Required independent proof
- All FOUR context-bearing factories (openContextReader, openContextWriter, openEvidenceReader, openEvidenceWriter) expose their corresponding new methods, nested close absent, nine runtime exports unchanged; old publication/taxonomy/evidence surfaces unchanged. Queue exclusion, reads while parked, shared poison both directions, read after release.
- Absent/null/N states against each expected form; stale expected with already-current; same desired by separate attempts retaining first timestamp; desired lower/higher order across negative,9/10,gaps,2^53,Int64 ceiling; actual ID retained and no allocator/revision ID invocation.
- Namespace request grammar and retained invalid/orphan pointer separate; cross-W/session desired/current pointers; duplicate logical key/public_id/selected seq; inactive/left history progress with no policy mutation.
- All five physical fields and exact raw timestamp conversion including sub-ms/refused range and equality; throw-if-called replay/conflict clock; invalid/regressed clock no-write including table version; equal clock permitted.
- Creation AND update killed after_write/before ACK, exact durable prior/target state and fresh-owner retry. Real SDK update/append/readback failure with table repaired and access asserted BEFORE same-owner second request; fresh owner recovery. First before_write refusal vs postattempt poison and exact literal triples.
- Independent expected rows, not first materializer output; real gated child for every writer; creation-record cleanup per path, measured child exit status, stderr drainage, bounded deadlines/kill/reap. No source mutation experiments without separate dispatch.

## 8. Exact ownership and freeze gate
Implementation requires a separate matching-SHA/base/worktree dispatch. This document alone authorizes no source task, staging, commit, push, PR, merge or deployment.

- **Neo, serialized core:** app/server/src/publication/service.ts; new app/server/src/publication/read-cursor.ts; new app/server/test/read-cursor-service.test.ts; new app/server/test/helpers/read-cursor-fixture.ts; new app/server/test/fixtures/read-cursor-v1/core/**; app/migrate-py/tests/test_revision_v1.py ONLY four literal IsolationTests insertions: read-cursor.ts immediately after association.ts in BOTH helper/publication tuples, publication/read-cursor immediately after publication/association in patterns, and the independent flagged sample `import * as readCursor from "src/publication/read-cursor";` immediately after the association sample. Preserve all other bytes; no directory exemption.
- **Ownership:** new app/server/test/read-cursor-ownership.test.ts; new app/server/test/fixtures/read-cursor-v1/ownership/**; accepted app/server/test/context-ownership.test.ts and app/server/test/association-ownership.test.ts ONLY the two string-literal amendments below. Optional context-ownership comment correction from "exactly these eight; the reader exactly the last four" to "exactly these ten; the reader exactly the last five". All consuming equality assertions, LEGACY reference, bundle/export lists and every other byte remain unchanged. Apply only in root dispatch syncing actual new methods, never earlier. Also owns accepted app/server/test/context-service.test.ts ONLY its writer contextMethods array adding advanceReadCursor and getReadCursor in sorted order, its readerContextMethods array adding getReadCursor in sorted order, the reader test title four context methods -> five context methods, and the adjacent comment Exactly the four READ methods -> Exactly the five READ methods. Preserve every other byte and exact equality. Root baseline-derived gate pins all four literals exactly once; apply only at the same explicit source-sync trigger.
- **Recovery:** new app/server/test/read-cursor-recovery.test.ts; new app/server/test/fixtures/read-cursor-v1/recovery/**.
- **Precision:** new app/server/test/read-cursor-precision.test.ts; new app/server/test/fixtures/read-cursor-v1/precision/**.
- **Root:** app/docs/contracts/read-cursor-v1.md; planning/verifier/evidence files outside product; exact integration/acceptance. Existing accepted contract documents stay unchanged: section1 of THIS new document supplies the explicit two-method override.

In EACH named accepted ownership test, amend exactly once:
OLD_WRITE = "appendMessages,getMessage,getPeer,getSession,joinSession,listMessages,registerPeer,registerSession"
NEW_WRITE = "advanceReadCursor,appendMessages,getMessage,getPeer,getReadCursor,getSession,joinSession,listMessages,registerPeer,registerSession"
OLD_READ = "getMessage,getPeer,getSession,listMessages"
NEW_READ = "getMessage,getPeer,getReadCursor,getSession,listMessages"
The association LEGACY.context.nested.context value REFERENCES CONTEXT_WRITE_METHODS; do not replace or amend that reference. Exact full-file transforms are derived from base d42ee3e9, not regex permission to edit a class/directory.

Eleven exact non-document paths, four new fixture prefixes, one root document. No storage.ts, context.ts, association.ts, models/goldens, protected codecs/errors, accepted helpers/exporters, package/lockfile or runtime/transport changes. The root checker verifies all four accepted-file exact transforms and before/after hashes of every gated source/test/benchmark input. Minimum test discovery is not coverage proof. All new suite preflights record absent APIs once, no skip credited as acceptance. Core publishes helper commitments early; root alone syncs held exact hashes. All writer fixtures use real bounded gated children, no second Python creator or gate bypass. Shared fixture creation records determine cleanup ownership, never prefix/mtime inference.

## 9. Readiness dispositions and limits
Readiness is advice, not product correctness. Accepted changes: all four factories named; explicit raw-microsecond clock comparison; explicit post-attempt corruption versus ambiguous readback classification; the exact two-constants-per-file amendments; future timestamp blocking until clock catches up; historical docs not rewritten. Rejected overclaims: NULL schema declaration proves physical impossibility; unknown update count must be success; retry always converges; governed deterministic error text cannot be asserted. The actual retained-null update statement and all product fault paths remain unmeasured until implementation tests. No prefreeze SDK probe is claimed.

Root records original draft406b0edf and corrected readiness notes separately. No live dataset or retained compatibility inspection, no Honcho claim, no authorization/admission or transport activation. Conditional retry, cooperative lock, bounded result versus engine work, instrumented versus real fault, and process death versus power loss remain distinct claims. Parent28 and all unrelated remaining issues stay open until their own evidence is complete.

## Amendment 2026-09-26 (overnight R1 + R2)

Made by v4-overnight (Claude Opus 5.5, AI) under `docs/overnight/DECISIONS.md` R1
and R2. This is an appended amendment, not an edit to §§1–9 above: every byte
above is unchanged, per this repo's own rule that a frozen contract is never
rewritten in place.

**R2 · digest ruling.** Issue #75 pinned `read-cursor-v1.md` SHA256
`164d3e91211552e5146b36d8d8e0cb22a628e4aa7f22d1fe2b70ae9a9f6a9508` as
authoritative. That text does not exist anywhere in this repository's git
history — `git log --all` finds no blob with that hash for this path, and the
only committed version of this file, at every commit since `d42ee3e9`, hashes
to `04f553dd20f572d6bc9c83b1c8752e69018ff5556ad2b2b1b1308162ca82f24f`
(`shasum -a 256 app/docs/contracts/read-cursor-v1.md`, verified against this
file both before and after this amendment's own §§1–9 bytes). **`04f553dd…`
is authoritative.** `read-cursor-service.test.ts` and
`read-cursor-recovery.test.ts` already cite `04f553dd…` correctly;
`read-cursor-recovery.test.ts` additionally records, honestly, that it was
*authored against* the nonexistent `164d3e91…` and explains the §8-only
difference. `read-cursor-ownership.test.ts:6` cited `164d3e91…` as `Authority`
rather than `authored against`; that stale citation is corrected to `04f553dd…`
alongside this amendment (comment-only, no behavioral change — the digest is
never asserted programmatically in that file).

**R2 · workspace `created_at` validation stays, at millisecond precision.**
§3's rule that a stored workspace `created_at` with a non-zero microsecond
remainder is `integrity_failure` — enforced by `validateWorkspaceRow` (this
kernel) via `resolveCursorScope` — is **intentional and unchanged.** #105
misdiagnosed this as a client/kernel unit bug; it measured false
(`docs/overnight/LANCEDB-FACTS.md`, `docs/overnight/DECISIONS.md` R1): the
physical `timestamp[us]` column and this kernel's raw-microsecond read/write
path are both correct, and every context method already accepts every
millisecond-aligned row. The actual #75 defect was a data producer,
`app/just/scripts/create_target19_dataset.py`, seeding
`workspaces.created_at` with genuine microsecond precision
(`datetime.now()`), which this validator correctly refused. The fix is at the
producer (truncate to the millisecond before writing, and refuse rather than
silently accept an existing sub-millisecond `default` row), not in this
contract or in `validateWorkspaceRow`. **Done means:** on a dataset produced
by the fixed script, `advanceReadCursor` and then `getReadCursor` succeed live
against nonzero millisecond `last_read_at`/`created_at` values — see
`docs/overnight/DECISIONS.md` R1/R2 and the live proof under
`app/server/test/fixtures/read-cursor-v1/live-r2/`.

**Reverse by:** striking this amendment section. Nothing above it changes as
a result; the digest and validation behavior simply return to being
unrecorded rather than recorded.

## Amendment 2026-09-26 (post-merge R7/R11/R17 + the audit's thin PASS rows)

Made by the `ac-evidence` slice, under `docs/overnight/DECISIONS.md` and the
acceptance-criteria audit at `docs/overnight/AC-MATRIX.md` (#75 row "Method-count
gates frozen at 10/5 while the facade grows"). Appended, not an edit: every byte
above is unchanged.

**What §1/§7/§8's "ten"/"five" (and "eight"/"four" before them) meant.** These
literals were never a claim about a live ceiling this contract polices as the
facade grows over time. **Fix round (2026-09-27):** an independent verifier
read the sentence below as contradicting the one above it; it is not — this
sentence is the historical snapshot the sentence above says these literals
were, not a second, competing claim. They named exactly two counts, true only
at the moment this contract's §1 amendment landed: the context WRITER facade
had ten methods and the context READER facade had five, immediately after
this slice added `advanceReadCursor`
(writer) and `getReadCursor` (writer + reader) to whatever the facade already
carried. §1's own words say so ("Explicitly amend the context-ingestion-v1
section8 eight/four method counts to ten/five") — each pair is a snapshot at
one commit, not a ceiling this contract polices going forward.

**Why this needed saying.** Nothing in §7/§8 stated that in those words, and the
audit found real readers who could take "gates frozen at 10/5" as a live
invariant this contract still enforces. It does not: the facade has grown every
time a later slice (R7 §28/29/30, R18 v3-parity, …) added a context method, and
each of those additions is its OWNER's contract to amend, not this one's. This
contract's own gate (§8) never re-asserts a facade-wide count; it names only
the two methods and the two byte-for-byte test-comment edits ("eight" -> "ten",
"four" -> "five") this slice itself made, once, in 2026-09-20's tree.

**Current count, for orientation only (not a new gate of this contract).** As
of this amendment, `app/server/test/context-ownership.test.ts:52-53` pins the
context writer facade at exactly thirty-three methods and the reader at
exactly twenty-one, with the growth history in the adjacent comments (R7 #30's
two search methods, R18's `closeSession`/`listSessionMembers`/`listTraces`).
Verified by running `bun test test/context-ownership.test.ts` on this tree
(see `docs/overnight/AC-MATRIX.md` for the exact pass count and date). The next
slice that adds a context method will change these numbers again, and should
amend ITS OWN contract, not this file.

**Reverse by:** striking this amendment section; §1/§7/§8 already say what they
said before, this only makes the scope of "ten"/"five" explicit.

## Amendment 2026-09-26 (post-merge R3/R4/R5 + #85/#31/#75 acceptance criteria)

Evidence only; §§1–9 and the R1/R2 amendment are unchanged. For #75 re-certification,
a representative set of §2–§5 checks was replayed on a real listening server
(`buildApp` from `src/index.ts`, bound to 127.0.0.1) over a fresh writer-gated
dataset, on both HTTP and MCP:

- The owner can advance and read. `created`, then `already_satisfied` with the first
  `last_read_at` byte for byte, then `advanced`. The five fields come back in physical
  order, and `last_read_at` is UTC-millisecond text.
- Other callers are refused with 403 `forbidden`: a peer-bound credential naming
  another peer (R3, path `/peer_name`), a credential for another workspace, and a
  `content:read`-only credential calling `advanceReadCursor`. A body naming a
  different workspace than the route bank gets 400; this one was replayed over HTTP
  only. MCP refuses the same mismatch as a tool error (`isError`,
  `payload workspace_name must match the connected bank`), not a 400; see the
  round-3 amendment in `authorization-integration-v1.md`. None of these changes the
  row.
- `conflict/backward` and `conflict/expected` are returned as results, not errors. A
  wrong-session message is `invalid_reference` at `/last_read_message_id`, and `"42"`
  fails the grammar.
- Recovery: a fresh server process that retries a write which already landed gets
  `already_satisfied` with the row that was kept.

Test: `app/server/test/read-cursor-live-transport.test.ts`. Driver:
`app/server/test/fixtures/transport-v1/live-server/child.ts`. See
`docs/overnight/DECISIONS.md` R2 and R3.

## Amendment 2026-09-28 (post-merge Nat style: one exported function per file, named after the file (origin, Nat 2026-09-12: 'split to function per file? like <= 600?'); ratchet app/server/test/one-function-per-file.test.ts)

`server/src/publication/read-cursor.ts` is now a re-export barrel; it exports nothing of
its own. The functions moved unchanged, with no behaviour change, into these files (see
`docs/overnight/DECISIONS.md` for the ratchet rule this satisfies):

- `read-cursor.parseGetReadCursor.ts`: `parseGetReadCursor` and `GetReadCursorRequest`.
- `read-cursor.parseAdvanceReadCursor.ts`: `parseAdvanceReadCursor` and
  `AdvanceReadCursorRequest`; the private `publicId` helper stays local to this file (its
  only caller).
- `read-cursor.validateWorkspaceRow.ts`: `validateWorkspaceRow`; the private
  `storedRequiredText` and `storedNullableText` helpers stay local to this file (their only
  caller).
- `read-cursor.encodeReadCursorRow.ts`: `encodeReadCursorRow`; the private `storedPointer`
  helper stays local to this file (its only caller).
- `read-cursor.constants.ts`: `READ_CURSOR_FIELDS`, `WORKSPACE_FIELDS` and the
  request/name bounds, as data.
- Helpers used by MORE than one of the files above each got their own single-export file,
  never an object/namespace bundle: `read-cursor.parseRequest.ts`, `read-cursor.name.ts`,
  `read-cursor.requireExactColumns.ts`, `read-cursor.storedText.ts`,
  `read-cursor.storedName.ts`, `read-cursor.storedTimestamp.ts`.

This section does not rewrite anything above it. Where the text above cites
`read-cursor.ts` by file, the function now named lives in the split file listed for it
above; importers of the barrel (`publication/read-cursor`) are unchanged, and
`app/migrate-py/tests/test_revision_v1.py`'s `HELPER_REUSE_ALLOWED` already covers every
sibling of this barrel by glob, so no new registration was needed there.
