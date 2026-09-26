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

## Amendment 2026-09-26 (overnight R7 (#28 part), hygiene: K13)

The v3-parity review (`docs/overnight/V3-PARITY.md` K13, defect 4) measured that
`createTrace` accepted **any** nonnegative `depth`, regardless of the resolved
`parent_id`'s own stored depth — a request could name `depth:"999"` on a brand-new root
trace with no `parent_id` at all, or `depth:"0"` under a real parent already at depth 5.
`depth` is documented (`DESIGN.md` section 10) as "derived/cache, not another edge" over
the `parent_id` tree, so an unchecked value defeats the one thing that field exists to
answer: "how deep is this trace in its own parent chain".

**Amended rule**: on a genuinely fresh `createTrace` (no existing row by `id` — section 3
above is unaffected: replay/conflict classification still runs first and does not
re-derive this), once `parent_id` is resolved (section 4's existing `invalid_reference`/
chain-walk checks still run first), `depth` must equal exactly:
- `0`, when `parent_id` is `null`;
- the resolved parent's own stored `depth` + 1, when `parent_id` is set.

A mismatch is `invalid_request` at `/depth` — a caller fault, decided before the clock is
ever sampled, exactly like every other pre-write STATIC-then-owner-read check in this
kernel. `prev_id` (the readable-sequence pointer) has no bearing on `depth`; only
`parent_id` does. No schema change, no change to identity/replay/conflict (section 3), the
chain-walk bound (section 4), or any other field's grammar.

`UNIQUE(name, workspace_name)` — named in `SPEC.md` section 14.2's historical `Trace`
interface comment ("Honcho's idiom") — is **deliberately NOT enforced** here, and stays
that way. Reasons, checked against the current authorities before writing this down:
- `DESIGN.md` section 10's current `traces` block (the shipped-direction schema this
  contract itself documents) carries no such constraint in its field list, unlike
  `sessions`/`peers`, which spell `UNIQUE(W, name)` explicitly in the same document.
  `SPEC.md` is superseded historical rationale on this point (repo `CLAUDE.md`: "`SPEC.md`
  preserves historical rationale, including superseded architecture"), not the current
  storage authority.
- Section 3 above already fixes identity on the caller-supplied `id` (nanoid21),
  workspace-scoped — the same "caller-stable identity, not content, not name" shape
  `session-link-v1.md` Decision 1 chose for the same reason. A second uniqueness axis on
  `name` would need its own conflict/replay classification (a same-name-different-id
  request is neither a replay of the named row nor unrelated to it), which no accepted
  contract defines and which K13's own "S"-sized dispatch does not include.
  `v3-parity`'s `oracle_trace` translation (`V3-PARITY.md` section 4.2) already derives
  `name` as `slug(query) + "-" + id[0..6]` specifically *because* the id suffix makes
  incidental collisions harmless — the adapter's own design does not need this enforced
  to work.
- Enforcing it now would be a behavior change on a **shipped, tested kernel**
  (`trace-service.test.ts`, `trace-ownership.test.ts`, `trace-recovery.test.ts`,
  `trace-precision.test.ts` all create traces with today's semantics), and this dispatch's
  scope (R7's #28 part) does not call for redesigning trace identity — only for exposing
  transport reachability, fixing the session-link cycle gap, and closing the two
  independently-measured hygiene defects (K13 depth, and this documentation).

If a future need requires `name` uniqueness (e.g. a UI listing that must not collide),
that is a fresh review with its own conflict-classification decision, not a default this
amendment should reach for.

Proof: `app/server/test/trace-service.test.ts` — "K13 (v3-parity hygiene review): depth
must be parent.depth + 1, or 0 with no parent" (three cases: root with nonzero depth
refused, child disagreeing with `parent.depth + 1` refused, depth exactly one more than
the resolved parent's depth accepted through a two-hop chain). `trace-precision.test.ts`'s
"all physical columns wire exactly" case was updated to build a real three-deep parent
chain for its `depth:"3"` wire value, since that value is no longer accepted in isolation.
