# Node lifecycle v1 — supersede / retire

Status: **DESCRIPTIVE CONTRACT**, written against shipped code. This document records what
`app/server/src/publication/lifecycle.ts` and the lifecycle methods on the context
writer/reader facades in `app/server/src/publication/service.ts` actually do, proven by
`app/server/test/lifecycle-service.test.ts`. Where the implementation and an intuitive
expectation disagree, the implementation is what is recorded here; disagreements are called
out explicitly rather than smoothed over.

Parent `Soul-Brews-Studio/arra-oracle-v4#29` (Parent `#28`). Base `f600636` — all five
kernels integrated, full suite 766/0 green.

Physical schema, `storage.ts` (`supersede_log`, exact order):
`id int64 NOT NULL, workspace_name utf8 NOT NULL, old_id utf8 NOT NULL, old_revision_id utf8
NOT NULL, old_title utf8 NULL, old_type utf8 NULL, old_source utf8 NULL, new_id utf8 NULL,
new_revision_id utf8 NULL, new_title utf8 NULL, new_source utf8 NULL, reason utf8 NOT NULL,
peer_name utf8 NULL, superseded_at timestamp[us] NOT NULL, operation_id utf8 NOT NULL,
h_metadata utf8 NULL`.

Sixteen physical columns. **There is no event-kind column.** A supersession and a retirement
are the same row shape; they are distinguished only by whether `new_id`/`new_revision_id` are
both null (retirement) or both non-null (supersession). A row with exactly one of that pair
null cannot occur through this interface: the stored-row codec (`encodeSupersedeLogRow`)
treats it as `integrity_failure`, never guesses which case was intended.

`old_source`/`new_source` have **no origin anywhere in this schema** — no code path that
writes through this kernel ever supplies a non-null value for either. A stored non-null value
in either column is corruption this codec refuses, not a value it invents or repairs.

`reason` is `utf8 NOT NULL`: the request grammar makes it a required, non-empty, bounded
field (4096 UTF-8 bytes, a chosen wire cap, not a schema fact) — there is no null spelling to
carry forward. `old_revision_id` is likewise `NOT NULL`, which is why every write forces a pin
(`expected_revision_id`): there is no schema state that represents "supersede without knowing
the current revision."

## 1. Request grammar

```
supersedeNode {workspace_name:W, node_id:N, expected_revision_id:N,
               new_node_id:N, new_revision_id:N, reason:S(<=4096B),
               peer_name:W|null, operation_id:OpId}
retireNode    {workspace_name:W, node_id:N, expected_revision_id:N,
               reason:S(<=4096B), peer_name:W|null, operation_id:OpId}
getRecallEligibility  {workspace_name:W, node_id:N}
listLifecycleHistory  {workspace_name:W, node_id:N, after_event_id:Int64Text|null, limit:1..100}
```

`W` is nonempty valid Unicode, <=256 UTF-8 bytes, exact/no normalization (the accepted
`name` grammar, shared with every other kernel). `N` is the declared node/revision namespace:
nanoid21, statically, for `node_id`, `expected_revision_id`, `new_node_id`, `new_revision_id`.
`OpId` (`operation_id`) is deliberately **not** nanoid-shaped: nonempty valid Unicode, the
caller's own retry key across attempts — narrowing it to nanoid21 would reject legitimate
operation ids the contract otherwise allows. `after_event_id` is the accepted non-negative
Int64 decimal-text grammar; `limit` is a small JSON integer in `1..100`
(`MAX_HISTORY_LIMIT`), never an Int64 wire field.

All object keys required; explicit nulls only (`requireClosedObject` over the raw strict
UTF-8 JSON parser, 1 MiB / depth 64, accepted duplicate-key/Unicode validation — same
grammar substrate as every other kernel in this package).

## 2. Identity, replay and conflict classification

Idempotency key is `(workspace_name, operation_id)`. `classifyLifecycleReplay` runs this
lookup **first**, before any other state check — including, for `supersedeNode`, before the
successor's forward chain is walked or its identity resolved. An exact replay (identical
`node_id`, `expected_revision_id`, `reason`, `peer_name`, and successor shape) returns the
**original retained row** with no clock sample and no write, `{outcome: "idempotent", row}`.
The same operation key under a **different** payload is `{outcome: "conflict", reason:
"operation_digest", row: <retained row>}` — a classification, never a thrown fault.

This ordering is load-bearing (proven by LC-1 in the test suite): if the successor named in
an original `supersedeNode` request later gains a new revision, an exact byte-identical
retry of the original request still returns `idempotent`, pinned to the **original**
successor revision — never a thrown `invalid_reference` naming a field the caller got right
at the time the request was first made.

Once no prior event exists for this operation key (`classifyLifecycleReplay` returns
`{replay: false}`), the fresh path (`writeLifecycleEventFresh`) runs:

1. **Pin check.** `expected_revision_id` must equal the node's current `current_revision_id`.
   A mismatch is a returned conflict, never thrown: `{outcome: "conflict", reason:
   "stale_pin", row: null}`.
2. **Already-terminal check.** A node that already carries **any** prior event (keyed on
   `old_id`) refuses a second one — append-only, no restore, no update, no supersede-back:
   `{outcome: "conflict", reason: "already_terminal", row: <the retained prior event>}`.
   Because of this rule, `old_id` is scoped-unique per workspace, and `listLifecycleHistory`
   for one node returns **at most one row** in the current implementation — the keyset shape
   (lookahead, per-page duplicate check, `after_event_id`) is kept in full anyway, so the
   method needs no reshaping if "already_terminal" is ever relaxed to allow more than one
   event per node.
3. `supersedeNode` additionally refuses, as `invalid_request` decided against the request
   (never as stored corruption): an immediate self-reference (`new_node_id === node_id`,
   checked before the mutation even starts), and any multi-hop forward chain from the
   successor that already closes back onto `node_id` (`walkForwardChain`, bounded at 1024
   hops via `new_id` links; hop 1025 is `limit_exceeded`).

`writeLifecycleEventFresh` allocates the event id as `max(existing SUPERSEDE_LOG.id across
the whole dataset, 0) + 1n`, under the owning gate and the shared serial queue — **not**
compare-and-swap. This is the same allocator pattern the message id/seq allocator uses
elsewhere in this package. The Int64 ceiling is guarded identically (`nextId >
INT64_CEILING` is `integrity_failure`), and a defensive post-allocation existence check
(`idTaken`) also fails `integrity_failure` if the freshly chosen id is somehow already
present.

## 3. Interaction with `publishRevision`

Retirement is present policy for publication, not only for the lifecycle kernel's own
writes. `publishFresh` and `resumeOrphan` (in `service.ts`) both consult `supersede_log`
before accepting a genuinely new revision or resuming an orphan onto an existing node, and
both refuse with `{outcome: "conflict", reason: "node_retired"}` if a terminal event already
exists for that `node_id` — never `not_found`, never `invalid_reference`.

**Ordering is load-bearing here too** (proven by the retired-node test and by LC-2): the
`node_retired` refusal is checked only in the **genuinely-fresh** publish path, reached
**after** `publishRevision`'s own exact-replay classification has already run and found no
match. A replay of a publish operation that was accepted **before** retirement therefore
still returns `idempotent`, unaffected by the node's later retirement — the retirement
refusal never reaches back and reclassifies an already-accepted write. A **new** revision on
a retired node, by contrast, is refused with `node_retired` regardless of whether the pin
would otherwise have matched.

`resumeOrphan` applies the identical rule to a same-operation orphan revision resuming onto
a node that was retired in the interim: even though the orphan's head pin still matches
(the node's head cannot have moved once a terminal event exists), resumption is refused as
`node_retired` rather than silently advancing the head of a node this kernel considers
terminal.

## 4. Clock discipline

Readers take **no clock**. `getRecallEligibility` reports eligibility **as of** a witness:
the highest `supersede_log.id` in the requesting workspace (`0` if the workspace holds no
lifecycle events at all, matching the allocator's own base), never a wall-clock timestamp.
The witness is deliberately scoped to the requesting workspace — `id` is allocated globally
across the whole dataset (same pattern as the message allocator), so a per-workspace maximum
is still a valid monotone watermark, and scoping this way means one workspace's lifecycle
event *count* is never leaked to a reader holding only another workspace's name, and a
duplicated maximum id anywhere else in the dataset cannot break eligibility reads outside
the corrupted workspace.

Only a genuinely fresh write (never a replay, never a conflict) samples `options.clock()`
once, and only inside `writeLifecycleEventFresh`. The sampled value must be a finite JS safe
integer; `microsToTimestamp` on `sampled * 1000n` is the range check (Gregorian years
1..9999) — there is no second copy of that grammar. A regressed or out-of-range clock is
`invalid_request` at root (the clock is operator/environment configuration, not a caller
field), and nothing is written.

## 5. Eligibility

`getRecallEligibility` returns `{eligible: boolean, witness_event_id: string}`. `eligible` is
computed as "does **any** `supersede_log` row exist with `old_id = node_id` in this
workspace" — presence of such a row (superseding or retiring, it does not matter which) makes
the node ineligible. A node that has itself never been superseded or retired is eligible
regardless of whether it is currently *named as a successor* by some other node's event: only
`old_id` participates in this check, never `new_id`. The own-row lookup uses a `limit 2`
query; more than one match is `integrity_failure`, matching the append-only guarantee that
`old_id` is scoped-unique.

## 6. Reads and bounds

`listLifecycleHistory` is a true keyset read ordered by `id` ascending, `limit+1` lookahead
to detect continuation, page bound `MAX_HISTORY_LIMIT` = 100. A duplicate event id straddling
the page (which cannot legitimately occur given `old_id` uniqueness, but is checked anyway)
is `integrity_failure` at root, the same rule `listMessages` applies to `seq_in_session`. In
the current implementation this always returns at most one row per node (section 2 above),
so `next_after_event_id` is always `null` in practice — the shape exists for a future
relaxation of "already_terminal," not because today's data can page.

`getRecallEligibility` and `listLifecycleHistory` both resolve the node first
(`invalid_reference` at `/node_id` if it does not exist in the requesting workspace) before
touching `supersede_log`.

## 7. Errors

Reuse the governed `arra-error/v1` codec for raw grammar faults (path names the offending
request field). Persistence/state faults reuse `arra-publication-error/v1`'s closed code set:
`invalid_request`, `invalid_reference`, `integrity_failure`, `writer_unavailable`,
`unsupported_dataset`, `recovery_required`, `limit_exceeded`. `not_found` is **excluded** from
this kernel's own returned-value vocabulary — every classification above (`stale_pin`,
`already_terminal`, `node_retired`, `operation_digest`) is a returned value, never a thrown
error, and never poisons the owner. Only a genuinely unexpected persistence fault (append
failure, missing readback row, field mismatch on readback) throws `recovery_required` and
poisons.

## 8. What this slice does NOT claim

- No restore, no update, no delete, no supersede-back. Append-only, permanently.
- No multi-table transaction. The `supersede_log` append is one `writeRow` call with its own
  before_write/after_write/after_readback boundary triple; nothing else in the dataset is
  touched atomically with it.
- No live dataset or retained-compatibility inspection beyond what the stored-row codec
  checks on read.
- **Ownership, recovery and precision test lanes do not exist for this kernel.** Only
  `lifecycle-service.test.ts` (core behavior) exists. Queue-exclusion-under-contention,
  poison-both-directions, kill-after-write recovery, and an Int64/boundary precision sweep
  are not covered by any test file today — this is a real, disclosed gap, not an oversight
  glossed over.

## 9. Places code and expectation disagreed

- It would be natural to expect a dedicated event-kind column (`"supersede"` vs `"retire"`);
  there isn't one. The distinction is entirely inferred from nullability of `new_id`/
  `new_revision_id`, and the codec treats a "half-null" pair as corruption rather than as a
  third, unnamed event kind.
- `listLifecycleHistory`'s full keyset machinery (lookahead, cursor, page bound) is present
  in both the pure grammar and the service method, but under the current "already_terminal"
  rule can never actually need to page — a single node can only ever have zero or one
  lifecycle event. This is deliberate future-proofing already present in shipped code, not a
  gap.

## 10. Amendment 2026-09-26 (overnight R7 (exposure part) + R8 (HTTP/MCP part))

`retireNode`, `supersedeNode`, `getRecallEligibility` and `listLifecycleHistory` had no
transport route: `knowledge/registry.ts` deliberately excluded the lifecycle kernel, so all
four answered HTTP 404 and no `kb_retireNode`/`kb_supersedeNode`/`kb_getRecallEligibility`/
`kb_listLifecycleHistory` tool existed on `tools/list` — measured in
`.tmp/understand/issue-29/transport-probe.ts` (`registry: false`, `MCP tool: false` for all
four; the sibling `listNodes` reached admission and answered 503, confirming the difference
was the registry entry, not policy). `docs/overnight/DECISIONS.md` R7 rules that kernel code
no client can call is not #29-done, and R8 keeps the full HTTP+MCP+CLI contract for #31.

All four are now registry entries at `scopePath: []` (`workspace_name` sits at the request
root in every parser above) — `getRecallEligibility` and `listLifecycleHistory` at
`content:read`, `retireNode` and `supersedeNode` at `content:write`. This amendment changes
reachability only. It does **not** change what "excluded from ordinary recall" means for
`listNodes`, the eligibility predicate's five DESIGN §9 conditions, or the terminal-successor
supersede question — those remain the separate, not-yet-ruled-on questions
`docs/overnight/DECISIONS.md`'s open-issues list and the #29 reopen comment name; a retired or
superseded node still appears, unlabelled, in `listNodes`/`getAcceptedHead` exactly as section
2 and section 9 above already record, whether reached over a transport or called directly.

Proof: `app/server/test/knowledge-expose13-registry.test.ts` (registry shape),
`app/server/test/knowledge-expose13-transport.test.ts` (HTTP 404→200, the four `kb_*` tools on
`tools/list`, read/write authorization refusals, against a fake bundle calling this file's own
real parsers), and `app/server/test/knowledge-expose13-live.test.ts`
(`supersedeNode`/`retireNode` → `listLifecycleHistory` → `getRecallEligibility` round-tripped
over both HTTP and MCP against a real writer-gated target-19 dataset, including a
same-payload MCP replay of each write landing `idempotent`).
