# Trace + trace-hit v1

Status: **DESCRIPTIVE CONTRACT**, written against shipped code. This document records what
`app/server/src/publication/trace.ts` and the trace methods on the context writer/reader
facades in `app/server/src/publication/service.ts` actually do, proven by
`app/server/test/trace-service.test.ts`. Where the implementation and an intuitive
expectation disagree, the implementation is what is recorded here.

Parent `Soul-Brews-Studio/arra-oracle-v4#28`. Base `f600636` — all five kernels integrated,
full suite 766/0 green.

Physical schema, `storage.ts` (exact order):

`traces`: `id utf8 NOT NULL, name utf8 NOT NULL, workspace_name utf8 NOT NULL, session_name
utf8 NULL, peer_name utf8 NULL, query utf8 NOT NULL, mode utf8 NULL, session_id utf8 NULL,
session_from_ts int64 NULL, session_to_ts int64 NULL, friction_score float64 NULL, confidence
utf8 NULL, parent_id utf8 NULL, prev_id utf8 NULL, depth int64 NOT NULL, status utf8 NOT NULL,
h_metadata utf8 NULL, internal_metadata utf8 NULL, created_at int64 NOT NULL, updated_at
int64 NOT NULL`. Twenty columns.

`trace_hits`: `workspace_name utf8 NOT NULL, trace_id utf8 NOT NULL, kind utf8 NOT NULL, ref
utf8 NOT NULL, target utf8 NOT NULL, line_start int64 NULL, line_end int64 NULL, excerpt utf8
NULL, content_hash utf8 NULL, captured_at timestamp[us] NULL, note utf8 NULL, position int64
NOT NULL`. Twelve columns. **There is no `id` column on `trace_hits`.** The only key is the
composite `(workspace_name, trace_id, position)`, and `position` is contractually contiguous
`0..n-1` per trace.

## 1. The unit trap — MEASURED, not inferred

`traces.created_at`, `traces.updated_at`, `traces.session_from_ts` and `traces.session_to_ts`
are raw **int64 MILLISECONDS**. `trace_hits.captured_at` is `timestamp[us]`, raw
**MICROSECONDS**. These are two different physical units inside one kernel, written by one
serialized turn.

The package's accepted `microsToTimestamp`/`timestampToMicros` helpers (`./rows`) are
**micros-only**. `trace.ts` defines its own millisecond converters (`millisToTimestamp`/
`timestampToMillis`) for the four `traces` timestamp columns, and reuses the accepted micros
helpers **only** for `trace_hits.captured_at` — the one column in this whole kernel that
really is micros. Reusing the micros helper on a `traces` column, or the millis converter on
`captured_at`, would silently mis-scale the value by 1000x; nothing in the type system catches
this, only file-local discipline enforced by the source comments and this document repeating
them.

Both units share the **same wire grammar**: exact UTC-ms text, years 1..9999, validated
through the governed `requireTimestampString`. That governed check — not either unit-specific
converter's own shape+round-trip logic — is what rejects a leading `"0000"` year, because
`timestampToMillis`'s own shape check alone would round-trip `"0000-06-15T12:00:00.000Z"`
successfully (it is below the Gregorian floor but shape-valid). Validating through the
governed helper first, before either converter runs, is what keeps a year-0000 value from
reaching a write at all — it fails `invalid_value` at the field pointer, never
`integrity_failure` at root.

## 2. Request grammar

```
createTrace {workspace_name:W, id:N, name:S(<=256B), session_name:S(<=256B)|null,
             peer_name:S(<=256B)|null, query:S(<=8192B), mode:S(<=256B)|null,
             session_id:S(<=256B)|null, session_from_ts:TS|null, session_to_ts:TS|null,
             friction_score:finite-number|null, confidence:S(<=256B)|null,
             parent_id:N|null, prev_id:N|null, depth:NonNegInt64Text,
             status:enum("open"|"complete"|"abandoned"),
             h_metadata:opaque-string|null, internal_metadata:opaque-string|null,
             hits:CreateTraceHitInput[<=256]}
getTrace       {workspace_name:W, id:N}
listTraceHits  {workspace_name:W, trace_id:N, after_position:NonNegInt64Text|null, limit:1..200}
```

`CreateTraceHitInput`: `{kind:TargetKind, target:JcsValue, ref:S(<=2048B), line_start:
NonNegInt64Text|null, line_end:NonNegInt64Text|null, excerpt:S(<=65536B)|null, content_hash:
S(<=256B)|null, captured_at:TS|null, note:S(<=65536B)|null}`. `position` is deliberately
**absent** from this input shape: the physical position of a hit is its index in the `hits`
array of the same request, assigned by the service — contiguous 0..n-1 by construction, not
by a separate check of a caller-supplied number that could disagree with array order.

`N` is nanoid21 for `id`, `parent_id`, `prev_id`, `trace_id`. `status` has **no enum declared
in the physical schema** — `TRACE_STATUSES = ["open", "complete", "abandoned"]` is this
module's own closed set, which is why a stored value outside it is `integrity_failure` (state
this service could not have written), not merely a request-grammar concern. `h_metadata`/
`internal_metadata` carry opaque JSON documents with no per-field byte bound beyond the whole-
request cap (1 MiB / depth 64) — inventing a narrower bound here would be a rule this module
has no contract basis for. `MAX_HITS` = 256 per `createTrace` call; nonempty is **not**
required — a trace may have zero hits and gain none later, because hits are immutable and
there is no append-hits method in v1.

`target` is normalized **eagerly at parse time** (`normalizeTarget`), so a malformed target
is refused before the request is ever queued — but the normalized result is **discarded** at
parse time and **re-derived** in `service.ts` against the trace's resolved
`workspace_name`, because the target-key domain includes `workspace_name` and the pure
grammar module has no authority over which workspace a request will finally land in.

## 3. Identity, replay and conflict

Identity is the caller-supplied `id` (nanoid21), workspace-scoped. `createTrace` looks up an
existing row by `(workspace_name, id)` and classifies:

- **No existing row** → the genuinely-fresh path (section 5).
- **Existing row, same trace fields AND same hits (element-for-element, by position)** →
  `{outcome: "already_satisfied", row, hits}`. Trace-field equality compares every wire field
  including the two millisecond timestamps converted through the same helpers the write path
  uses. Hit equality (`hitMatches`) compares `kind, ref, target (canonical JSON text),
  line_start, line_end, excerpt, content_hash, captured_at, note` per hit.
- **Existing row matches, but the stored hits are an exact, in-order PREFIX of the requested
  hits and strictly fewer in count** → `recovery_required`, not a conflict. This is TR-2: a
  retry against a fresh, unpoisoned owner (e.g. after a process restart) can land on
  incomplete stored state — the trace row and *some prefix* of its hits landed, then the
  process died before the rest were appended. A byte-identical caller must not be blamed for
  an ambiguous partial write it did not cause; recognized **only** as an exact element-wise
  prefix, never a superset, never a reordering.
- **Anything else** (different trace fields, or hits that are not an exact prefix match) →
  `{outcome: "conflict", reason: "payload"}` — a returned value, not thrown.

Before either equality check runs, every already-stored hit's `position` is verified
contiguous `0..n-1` (TR-3); a gap or duplicate there is `integrity_failure` at root, decided
**before** any payload comparison — stored corruption outranks an ordinary caller mismatch
everywhere in this kernel.

## 4. Chain policy — `parent_id` / `prev_id`

Both pointers, when present, must resolve to an existing trace in the **same workspace**:
`invalid_reference` at `/parent_id` or `/prev_id` respectively if the immediate reference does
not resolve. Anything wrong **deeper** in the chain from that point on is stored corruption or
a bound, never the caller's fault — `assertTraceChain` walks the existing chain over
whichever pointer column applies, bounded at 1024 visited stored ancestors (the row being
created is not yet in the table and is not counted); the 1025th hop is `limit_exceeded`. A
self-referencing cycle found during that walk, or a workspace mismatch on any visited row, is
`integrity_failure`. This mirrors `assertReplyChain`'s bound and shape exactly (same 1024
constant, same "not counted" rule for the row being created).

`parent_id` and `prev_id` are independent pointers walked **separately** — nothing here
asserts a relationship between the two chains.

## 5. Fresh write

TR-1(b): every physical hit row is built and validated (`encodeTraceHitRow`'s own shape
check included) in a **pre-write pass**, entirely before the trace row's own `writeRow` call
starts the ambiguous post-write window. A hit-shaping fault must refuse the whole request
atomically, before anything is durable — once the trace row lands there is no way to attach
hits to it afterward (v1 is immutable, no append-hits method), so any hit fault discovered
only *inside* the write window would strand an orphan trace row and poison the owner for what
is really an ordinary caller mistake.

Only a genuinely fresh creation samples `options.clock()`, once. The sampled value becomes
`traces.created_at` **and** `traces.updated_at` — both raw milliseconds, `updated_at ===
created_at` on every fresh write, by construction. (Encode-side, this equality is not
re-asserted by the codec itself: an imported legacy row could legitimately differ, and the
codec has no way to distinguish "just created" from "imported" by row shape alone — the
equality is a fact about *this write path*, checked by the caller/test, not a schema
invariant `encodeTraceRow` enforces.)

The trace row lands via one `writeRow` call (its own before_write/after_write/after_readback
triple); each hit then lands via its own `writeRow` call, `wroteAlready: true` from the first
hit onward — because once the trace row itself is durable, the whole operation is inside the
ambiguous window, and a hook failure on any later row must poison rather than merely refuse.
**No multi-table transaction is claimed**: the trace row and each hit row are separate
appends, each independently verified on readback. If the trace row lands and a later hit's
append or readback genuinely fails (an SDK or verification fault), that is an ambiguous
partial write — the owner poisons and the caller sees `recovery_required`, exactly as for any
single-row mismatch elsewhere in this kernel. If a hit instead fails with a *safe* contract
error (e.g. `encodeTraceHitRow` raising `integrity_failure`), the owner still poisons (once
anything is durable, every later fault is inside the ambiguous window) but the caller sees
that safe code rather than a collapsed `recovery_required` — TR-1(b)'s pre-write pass exists
specifically so this class of fault cannot occur *after* the trace row lands in the first
place.

## 6. Reads and bounds

`getTrace` returns the literal row or `null` — absence is `null`, never `not_found` (that
code's fixed message is node-specific to a different kernel).

`listTraceHits` is keyset, ordered by `position` ascending, `limit+1` lookahead
(`MAX_PAGE_LIMIT` = 200), page bound enforced the same way as every other keyset read in this
package. Beyond the lookahead-duplicate check, the read additionally enforces TR-3 against
the **keyset cursor itself**: the first position seen must be exactly one past `after`
(`0` when `after` is absent), and every following one its immediate successor — a gap, a
duplicate, or an out-of-order value read back is stored corruption, never a caller mismatch,
`integrity_failure` at root.

Hits are **passive locators only**. `ref` is a caller-supplied opaque string — "where, within
or alongside the resolved target, this hit points" — and is never dereferenced, never
verified, never network-fetched by this kernel. `target` is stored and returned as its
canonical JSON **text**; a read path never re-parses it into a nested object, because the wire
contract does not define a shape for that. Nothing here claims to capture ground truth about
what a hit's target currently contains — a hit is a record that something was observed at a
location, not a fetch of that location.

## 7. Errors

Reuse the governed `arra-error/v1` codec for raw grammar faults. Persistence/state faults
reuse `arra-publication-error/v1`'s closed code set: `invalid_request`, `invalid_reference`,
`integrity_failure`, `writer_unavailable`, `unsupported_dataset`, `recovery_required`,
`limit_exceeded`. `not_found` is **excluded**; absence reads as `null` (`getTrace`) or an
empty/short page (`listTraceHits`), never `not_found`. `{outcome: "conflict", reason:
"payload"}` is a returned value, never thrown, never poisons.

## 8. What this slice does NOT claim

- Traces and hits are **immutable** in v1: there is no update method, and none should be
  added without a fresh review (stated directly in the source header).
- No multi-table transaction across the trace row and its hits (section 5).
- No dereference, no fetch, no capture-truth claim for any hit (section 6).
- **Ownership, recovery and precision test lanes do not exist for this kernel.** Only
  `trace-service.test.ts` (core behavior, including the TR-1/TR-2/TR-3 regressions) exists.
  Queue-exclusion-under-contention, poison-both-directions, kill-after-write recovery, and a
  dedicated millisecond/microsecond boundary precision sweep beyond what the core test
  exercises are not covered by any test file today — a real, disclosed gap.

## 9. Places code and expectation disagreed

- It is easy to assume one timestamp unit for an entire kernel; this one deliberately mixes
  two, in the same serialized write, and the accepted shared helpers are unit-specific enough
  that using the wrong one on the wrong column would compile and pass a shallow test while
  silently corrupting every value by a factor of 1000.
- `trace_hits` having no `id` column at all — its key is purely positional — means a hit
  cannot be addressed independently of its trace and position; there is no way to reference
  "this hit" from outside the `(workspace_name, trace_id, position)` triple.

## 10. Amendment 2026-09-26 (overnight R7 (exposure part) + R8 (HTTP/MCP part))

`createTrace`, `getTrace` and `listTraceHits` had no transport route: `knowledge/registry.ts`
deliberately excluded the trace kernel, so all three answered HTTP 404 and no `kb_createTrace`
/`kb_getTrace`/`kb_listTraceHits` tool existed on `tools/list`. This was measured directly:
`.tmp/understand/issue-28/`'s repro showed a conclusion citing two traces could not even be
published over any transport, because no transport could create the traces it cited first.
`docs/overnight/DECISIONS.md` R7 rules that kernel code no client can call is not #28-done, and
R8 keeps the full HTTP+MCP+CLI contract for #31.

All three are now registry entries at `scopePath: []` (every parser above carries
`workspace_name` at the request root) — `getTrace` and `listTraceHits` at `content:read`,
`createTrace` at `content:write`. Caller-asserted attribution (`peer_name`,
`session_id`/`session_from_ts`/`session_to_ts`, `h_metadata`, `internal_metadata`) remains
exactly as unverified as section 5/6 above already document; exposing the transport route
changes reachability only, not what this kernel validates or trusts. The mixed
`continues`/`forked_from` session-link cycle question `docs/overnight/DECISIONS.md` R7 raises
for `#28` is a separate, session-link-side decision and is out of scope for this amendment.

Proof: `app/server/test/knowledge-expose13-registry.test.ts` (registry shape),
`app/server/test/knowledge-expose13-transport.test.ts` (HTTP 404→200, `kb_createTrace`/
`kb_getTrace`/`kb_listTraceHits` on `tools/list`, workspace-scope and read/write authorization
refusals, against a fake bundle calling this file's own real parsers), and
`app/server/test/knowledge-expose13-live.test.ts` (`createTrace` → `getTrace` →
`listTraceHits` round-tripped over both HTTP and MCP against a real writer-gated target-19
dataset, including a same-payload MCP replay of `createTrace` landing `already_satisfied`).

## 11. Amendment 2026-09-26 (overnight R11 + R17, migration)

Appended, not rewritten. Context: the #34 copy migration under [`docs/overnight/DECISIONS.md`](../../../docs/overnight/DECISIONS.md) R11 and R17 (as corrected 22:00).

**What changed.** Legacy `traces.status` values `raw | distilled | retired` are outside this kernel's closed set `open | complete | abandoned`, so a verbatim copy reads back as `integrity_failure`. The copy migration maps `raw -> open` (ruled: R17 as corrected 22:00) and, as an implementer extension that is **not** ruled, `distilled -> complete` and `retired -> abandoned` (DESIGN §10 still lists `raw | reviewed | distilled | retired`). The legacy value is recorded on the trace's report record. Legacy integer-millisecond columns are copied raw, and `distilled_to` / `distilled_at` become a revision link plus revision metadata. A legacy hit kind outside `TARGET_KINDS` (e.g. `file`) is rejected with a record; a kind inside it is unresolved, because a free-text `ref` does not determine a structured `target`.

**Fix round, same night.** Appended. Proof only; the mapping is unchanged. The ruled leg `raw -> open` now has its own fixture trace and test (`test_ruled_raw_trace_status_maps_to_open`); before, only the unruled `distilled`/`retired` extension was exercised. A hit whose kind is inside `TARGET_KINDS` (a `url` with a valid https ref) is tested as `unresolved` (`locator_unmappable`). It stays unresolved on purpose: `trace_hits` rows are immutable and are created only with their trace, and Python cannot reproduce the kernel's WHATWG `requireUrl` check. Writing such a row directly would store a target the kernel never validated.

## 12. Amendment 2026-09-26 (overnight R18 (V3 + K5 + V7))

Appended, not rewritten. Context: the v3-compatible MCP adapter (#31, [`docs/overnight/V3-PARITY.md`](../../../docs/overnight/V3-PARITY.md) §4.2-§4.3, §5, §7) and [`docs/overnight/DECISIONS.md`](../../../docs/overnight/DECISIONS.md) R18.

**K5, a new content:read method: `listTraces`.** Request `{workspace_name, parent_id|null, prev_id|null, query_contains|null, after_created_at|null, after_id|null, limit(1..100)}`; `after_created_at`/`after_id` are a COMPOUND keyset cursor, refused if only one is present (this kernel's ordering contract, `created_at desc, id asc`, is not a total order on `created_at` alone -- two traces can share a millisecond). `DatasetAdapter.orderedProjection` sorts by exactly one column, so the compound sort, the cursor comparison and `query_contains` (a plain, bounded substring scan -- not SQL `LIKE`, no wildcard semantics) all finish in JS over a widened scan window (`MAX_SCANNED_TRACES = 1000`), the same "widen the window, filter in memory" tradeoff `listNodes` already uses for its `type_term` filter. Every returned row carries `derived_from_count`: the number of `revision_links` rows (`target_kind="trace"`, `relation="derived_from"`, this trace's `target_key`) whose `revision_id` is still its node's CURRENT head. `revision_links` is a RECONCILED projection (`reconcileRevisionAssociations`), not written by `publishRevision` itself -- a caller that just wrote a `derived_from` link must reconcile that one revision before `derived_from_count` reflects it (the V3 adapter's `oracle_trace_distill` does this immediately after publish, `publish.ts`'s new `reconcile` option). `coverage` is `"partial"`, never silently `"full"`, when the scan window could not prove every stored trace matching the SQL predicate was examined. Classified in `registry.peerFields.ts` as asserting no acting peer (`listTraces: []`).

**V3, the trace family: `oracle_trace`, `oracle_trace_get`, `oracle_trace_chain`, `oracle_trace_distill`.** `mcp/legacy-v3/trace-hits.ts` translates v3's `foundFiles`/`foundCommits`/`foundIssues`/`foundRetrospectives`/`foundLearnings`/`foundResonance`: a full-length commit hash (40-hex sha1 or 64-hex sha256) under a `project` that parses to `owner/repo` becomes an indexed `commit` hit, and an issue under the same `repo` becomes an indexed `issue` hit (its `url` is synthesized as `https://github.com/<repo>/issues/<n>` when the caller gave none); anything that does not qualify is `unrepresentable_*`, kept verbatim in `h_metadata.legacy` rather than silently dropped. `summary` counts the RAW v3 input arrays, exactly as v3's own `trace/store.ts` did (`file_count` folds in `foundFiles`+`foundRetrospectives`+`foundLearnings`+`foundResonance`, since none of the latter three has an indexed hit kind). `oracle_trace_distill` publishes a NEW node `derived_from` the trace -- `learning` when `promoteToLearning` is set, else `conclusion` (R10, D4) -- and never rewrites the trace row; re-distilling adds a second node. `oracle_trace_chain` walks `prev_id` backward (always available) and, with K5, `listTraces({prev_id})` forward one hop at a time; reaching more than one successor is a fork (v4 allows what v3's exclusive `oracle_trace_link` pointer never could) and stops the walk, reporting `forked:true, branches:[...]` rather than guessing a branch. `oracle_trace_get`'s `child_trace_ids` (`listTraces({parent_id})`, bounded, `truncated` warned if more exist) and `next_trace_id` (`listTraces({prev_id}, limit:2)`, left `null` with a `semantic_change` warning on a fork) are both K5-backed, shipping in this same slice rather than staying `field_unavailable`.

**A fixture defect K5 found, fixed at the root.** `app/migrate-py/tests/export_publication_fixture.py` seeded every workspace's baseline trace with `status="raw"` -- a legacy v3 status outside this kernel's closed `open | complete | abandoned` set (§1's own rule: a stored value outside it is `integrity_failure`, decoded or not). Nothing before K5 ever ran an UNFILTERED scan of `traces` (every other reader only cites the seeded `trace_id` as an opaque evidence-link target, per `association-service.test.ts`); `listTraces` is the first, and it failed closed on the poisoned row exactly as designed. Fixed at the fixture (`status="complete"`): no test anywhere asserted the old value, and TS-side decoding of an out-of-band `status` is not something Python test fixtures should ever produce.

**Tests:** `test/mcp-v3-trace.test.ts` (V3, over the real wire, inside the writer gate), `test/trace-list-service.test.ts` (K5 kernel + isolation + HTTP/MCP reachability), `test/trace-ownership.test.ts` (the context facade's exhaustive method-count check, now twenty-three/twelve), `test/mcp-v3-acceptance.test.ts` (steps 14-19, `oracle_trace`/`oracle_trace_get`/`oracle_trace_chain`/`oracle_trace_distill`/`oracle_trace_list`, GAP -> PASS).

**Fix round (2026-09-27, same R18).** Appended, not rewritten. An independent verifier refuted the slice above on four points; all four are fixed here, each with a failing-first test proving the old behavior and a passing one proving the new.

1. **Regression: nine OTHER ownership/service test files hard-code the same exhaustive context facade method list `listTraces` was added to.** Only `trace-ownership.test.ts` was updated originally. `chat-ownership.test.ts`, `lifecycle-ownership.test.ts`, `search-chunk-ownership.test.ts`, `session-link-ownership.test.ts`, `context-ownership.test.ts`, `context-service.test.ts`, `association-ownership.test.ts`, `read-cursor-ownership.test.ts` and `read-cursor-service.test.ts` all now carry `listTraces` in their literal lists (and the twenty-two/eleven counts they narrate, now twenty-three/twelve). Proof: `bun run test:association|chat|context|lifecycle|read-cursor|search-chunk|session-link` and `bun test test/context-service.test.ts` are green again (were 12 failures across these nine files, 122 pass / 12 fail).
2. **K5, the keyset cursor dead-ended past `MAX_SCANNED_TRACES` (1000).** `service.listTraces.ts` parsed `after_created_at`/`after_id` but never pushed them into the SQL predicate, so every page re-scanned the SAME newest 1000 rows regardless of how far a caller had already paged; and the returned cursor was derived from the last MATCH, not the last row examined, so a `query_contains` filter sparse enough to leave a whole widened window empty came back with a null cursor while `has_more` stayed `true` -- a dead end mid-table, not only past row 1000. Fixed by pushing the cursor into SQL (`created_at < X OR (created_at = X AND id > Y)`, `listNodes`' `idScope` shape) and by walking the sorted window like `listNodes` does -- the cursor is the last row EXAMINED (match or not) when it stops, never merely the last MATCH. Proof: `test/trace-list-cursor.test.ts` (2005 planted rows, three widened-window boundaries; RED on the un-pushed predicate) and `test/trace-list-service.test.ts`'s existing small-scale pagination test (still green -- catches the interim over-correction that jumped the cursor to the window's tail even when the page hadn't reached it).
3. **V7, `oracle_trace_list` duplicated rows.** Its walk copied a `null` cursor straight back into the next kernel call whenever `has_more:true` arrived with nothing to resume from (K5's dead end, above), which restarts K5 from the newest trace instead of continuing -- rows already returned came back again, and rows past the restart point were never reached. Fixed: the walk now stops (an honest `has_more:true`, never presented as complete) the moment a page claims more with no cursor, rather than looping. Proof: `test/mcp-v3-trace-list-walk.test.ts`, a deterministic stub of the exact K5 dead-end shape (RED: 10 calls and a duplicated row on the old walk; GREEN: 2 calls, no duplicate).
4. **V7, `oracle_trace_chain` dropped the requested trace when a fork existed UPSTREAM of it.** The forward walk started at the backward walk's earliest ancestor and tried to re-derive the path to the caller's own trace via `listTraces({prev_id})`; an unrelated fork anywhere on that path (even one that has nothing to do with the requested trace) stopped the walk before it ever reached it, so `position` fell back to 0 on a chain that no longer contained the trace asked for. Fixed: `prev_id` is single-valued, so the backward walk can never itself hit a fork -- the path it already walked (root to the requested trace) is kept outright, and only the segment PAST the requested trace still needs a `listTraces` round trip (where a genuine fork is real, reportable ambiguity in that trace's own future, not noise from an unrelated sibling). Proof: `test/mcp-v3-trace.test.ts`'s new case, `R <- S1 <- S2` plus an unrelated fork off `R`; asking about `S2` still returns `[R, S1, S2]` at position 2 (RED before the fix: `chain:[R], position:0`).

Also fixed as part of this round, not separately ruled: the amendment date above (this section) read 2026-09-27 in the pre-fix-round draft; corrected to the date R18 itself landed.

## 13. Amendment 2026-09-26 (overnight R18 (V3 + K5 + V7, D4, D11))

Appended, not rewritten. Fix round 2 of §12, same ruling: [`docs/overnight/DECISIONS.md`](../../../docs/overnight/DECISIONS.md) R18 (V3 + K5 + V7, D4, D11), design in [`docs/overnight/V3-PARITY.md`](../../../docs/overnight/V3-PARITY.md) §2.5, §4.3-§4.4, §5. An independent verifier refuted §12 on four blocking points. Each is fixed below with a test that was red before the fix or, where the code was already right, red under the mutation the verifier used.

1. **K5: a `created_at` tie straddling the end of the scan window lost rows.** §12 ordered the 1000-row window by `created_at` alone, so which rows of a tie group at the window's tail made it in was the storage engine's choice. When a walk ran off such a window, the cursor `(tail.created_at, tail.id)` then excluded, permanently, every tied row that had not fit and had a smaller id. The last page still said `coverage:"full"`. This supersedes §12's first-paragraph wording ("the cursor comparison ... finish in JS") and its missing disclosure. The cursor comparison is SQL (fix round 1). Now the window is also cut at a tie boundary (`service.scanTraceWindow.ts`). Every millisecond above the tail is whole, because a row there would outrank the tail row. So a full window drops its tail millisecond, and the next page's predicate still reaches all of it. If the whole window is one millisecond (at least 1000 tied rows), that millisecond is re-read ordered by `id` and paged by `id`. Both cases keep a whole prefix of the kernel's own `(created_at desc, id asc)` order, and the cursor always moves strictly forward, so the walk visits every row exactly once. `coverage` is `"partial"` whenever the first read filled the window. Proof: `test/trace-list-tie.test.ts`. It plants 998 newer rows plus 8 tied rows across the boundary, and a 1003-row tie group bigger than the window. Before the fix, 6 of the 8 tied needle rows were lost and 3 of the 1003 wide-group rows were never visited.
2. **K5 request grammar: new required-but-nullable key `depth`.** The request is now `{workspace_name, parent_id|null, prev_id|null, depth|null, query_contains|null, after_created_at|null, after_id|null, limit}`. `depth` is canonical non-negative int64 decimal text, the same form `createTrace` stores, and it goes into the SQL predicate as `depth = N`. Omitting the key is `missing_field`, as for every other filter key (K3's idiom). Proof: `test/trace-list-service.test.ts` ("depth filters ...", "depth is int64 decimal text or null ...").
3. **V7 `oracle_trace_list`: v3's `project` and `depth` filters were dropped silently** (v3 `src/trace/list.ts:17-19`). This violated §2.5, "removals are never silent". `depth` (a non-negative integer) goes to K5. `project` is compared in the adapter for exact equality with the trace's `h_metadata.project`. That is where `oracle_trace` records v3's `project` verbatim, and the kernel treats `h_metadata` as opaque. Both filters apply before `offset`, as in v3. The adapter refuses a `depth` that is not a non-negative integer, and a non-string `project`, with `unsupported_argument` at `/depth` or `/project`. Any argument outside v3's six is named `argument_ignored`. Sometimes the ten-page walk (1000 traces) runs out before the filters and offset are exhausted. The page then carries a `truncated` warning on `traces` and `has_more:true`, never a silent short page. `offset` and `limit` follow v3's own `boundedInteger` clamps (`[0, 10000]`, `[1, 100]`). `scope` is the recorded `h_metadata.scope`, else v3's default `"project"`; before, it was a bare `null`. Proof: `test/mcp-v3-trace.test.ts` over the real wire, including the verifier's exact call `{project:"github.com/nobody/none", depth:5}`, and `test/mcp-v3-trace-list-walk.test.ts` with a stubbed kernel.
4. **Per-page cost and the flaky walk test.** Each `listTraces` row used to cost its own `traces` read plus a `revision_links` read and a `nodes` read. The whole page now takes one `id IN (...)` read, and `derived_from_count` is counted for the page in one pass (`service.countTraceDerivations.ts`, chunked `IN` lists of at most 200). The rule is unchanged: a link counts only while its revision is its node's current head, and two nodes naming one head revision is `integrity_failure`. `test/trace-list-cursor.test.ts`'s 21-page walk measured 2.05 s before and 0.09 s after, both at load average about 6. The verifier saw it exceed bun's 5 s default 4 out of 4 times at load 14-18. It now has an explicit 30 s timeout. The current-heads rule is pinned by `test/trace-list-heads.test.ts`: a real publish, reconcile, and a revision that drops the link. Counting every link gives 2 instead of 1.
5. **R18 D4 pinned.** `oracle_trace_distill` already published `learning` when promoted and `conclusion` otherwise, but no test read the type back, so swapping the two left 41/41 green. `test/mcp-v3-trace.test.ts` now reads each distilled node's accepted head. It asserts the `type` term and the `derived_from` link to the trace, and it fails under the swap.

Also fixed in this round, all nonblocking:
- `oracle_trace_get`'s `next_trace_id` is now tested for both cases: a single successor, and `null` plus `semantic_change` on a fork.
- `oracle_trace_chain` names every branch of a fork up to 100, with `truncated` beyond; before, it named only 2.
- Both catalogue descriptions now say what changed from v3. That covers case-sensitive substring `query`, `status` limited to raw or distilled, no `total`, and forward walking with forks.
- A well-formed trace id that names nothing is `no_results` in `oracle_trace_get` and `oracle_trace_distill`. It was `kernel_error` with no wrapped envelope.
- `oracle_trace_distill` names v3's `oracle`, `source`, `finding` and `metadata` arguments `argument_ignored`.

Not changed, and disclosed. `oracle_trace_distill`'s `operation_id` is still random unless the caller passes `idempotency_key`. V3-PARITY §4.3 specifies `"v3-distill:"+sha256(canonical input)`. That would make an identical re-distill replay the first node instead of adding a second, which contradicts the same section's "re-distilling adds a second node" and v3's own behavior. The choice is left to the design owner. D11 is unchanged: linking two existing traces stays not carried.

**Tests:** `test/trace-list-tie.test.ts`, `test/trace-list-heads.test.ts` (new); `test/trace-list-service.test.ts`, `test/trace-list-cursor.test.ts`, `test/mcp-v3-trace.test.ts`, `test/mcp-v3-trace-list-walk.test.ts` (extended).
