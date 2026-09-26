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
- **Ownership, recovery and precision test lanes exist**: `lifecycle-ownership.test.ts`,
  `lifecycle-recovery.test.ts` and `lifecycle-precision.test.ts` cover queue-exclusion-under-
  contention/poison-both-directions, kill-after-write recovery, and an Int64/boundary precision
  sweep, respectively, alongside `lifecycle-service.test.ts`'s core behavior. *(Fix round 2
  correction, 2026-09-26: this bullet previously said none of that coverage existed anywhere;
  `.tmp/understand/analysis-29.json`'s fix plan B7 measured the claim false — all three files
  predate this slice (`a9a6ed0`) — and §12's "Not changed here" line below had re-affirmed the
  false claim instead of correcting it.)*

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

## 11. Amendment 2026-09-26 (overnight #10 slice, lifecycle peer reference)

This section amends §1's `peer_name:W|null` and §2's fresh-path steps. The text above is left as written.

**Authority, stated precisely.** This amendment was made in the overnight #10 slice, the slice that implements R14. It is **not** an R-numbered ruling: `docs/overnight/DECISIONS.md` rules nothing about lifecycle. It implements fix plan B of the independent #10 re-verification (`.tmp/understand/analysis-10.json` in the integration worktree). That plan measured `supersedeNode` and `retireNode` accepting, and writing to `supersede_log`, a `peer_name` that exists only in another workspace or nowhere. It is recorded in its own commit so it can be reverted without touching R14.

**What changed.**

- A non-null `peer_name` on `supersedeNode` or `retireNode` must resolve to exactly one `peers` row in the request's own workspace, the same rule every other peer reference in the context kernel follows (for example `createTrace`).
  - None: `invalid_reference` at `/peer_name`.
  - More than one: `integrity_failure`.
  - `null` is still accepted and means no actor was named.
- The check runs in `writeLifecycleEventFresh`, the fresh path only, so replay classification still runs first (§2).
  - An exact replay of an event accepted before this amendment, or of one whose peer no longer resolves, still returns `idempotent` with the retained row.
  - A refused request writes nothing and consumes nothing, so its `operation_id` stays free for a corrected retry.
- Position in the fresh path: after the node resolves (`/node_id`), before the pin and already-terminal checks. A request naming a nonexistent peer is told so rather than handed a `stale_pin`/`already_terminal` conflict to retry into. For `supersedeNode` the successor references (`/new_node_id`, `/new_revision_id`) still resolve first, as before.

**Why.** `supersede_log` is audit-shaped: v3's equivalent leaked across tenants (#10 defect 2). A caller-supplied actor name that is never checked against the workspace's peers lets alpha's audit row name a beta-only peer. That is not a read leak, but it is an integrity gap in the one table that records what changed and who did it.

**Evidence.** `app/server/test/workspace-isolation-supersede.test.ts` covers a beta-only peer and a peer that exists nowhere, both refused from alpha and both leaving history empty; alpha's own peer is accepted and replays idempotently; `null` is accepted; and a refused operation id is reusable. The test was red on `aff9c65` (the beta-only peer was accepted). `lifecycle-precision.test.ts` previously named an unregistered `"peer-a"` and now names the fixture's seeded alpha peer.

**Not changed here.** When this slice was written, lifecycle had no transport. Section 10 above (the expose-13 slice, merged first into `v4/overnight-26sep`) added the four registry entries, and its tests cover transport-level authorization. This section only adds the workspace check on `peer_name`, and that check applies on every transport, because it runs in the kernel.

## 12. Amendment 2026-09-26 (overnight R11 + R17, migration)

Appended, not rewritten. Ruling: [`docs/overnight/DECISIONS.md`](../../../docs/overnight/DECISIONS.md) R17.

**What changed.** The #34 copy migration writes legacy supersede/retire history through `supersedeNode` / `retireNode`, not as copied rows. A legacy `supersede_log.reason` that is NULL becomes the literal `"legacy: reason not recorded"`, because `reason` is a required request field and a NOT NULL column here; the report counts these rows (`policies.null_reason_backfilled`, next to `null_reason_rows_in`). Events are pinned to the first revisions the same run published, applied in legacy `superseded_at` order with the kernel clock set to that legacy time. The kernel allocates `supersede_log.id` (max + 1), so legacy integer ids are not preserved; each legacy row's record carries its legacy id as the key. A second legacy event on an already-terminal node is reported rejected (`conflict_already_terminal`), never overwritten.

**Why.** R17: the target requires a reason, and the legacy log allowed none. Inventing a plausible reason would be worse than a fixed, searchable marker.

**Fix round, same night.** Appended. A legacy `memories.superseded_by` with NO `supersede_log` row gets ONE synthesized supersede event at the legacy `superseded_at`, with the R17 reason `"legacy: reason not recorded"`, counted in `policies.missing_log_row_backfilled`. This path now has a fixture row and a test that pins the stored event. Before, a mutation that skipped it still passed.

## 12. Amendment 2026-09-26 (overnight R7 (#29 part))

*(Fix round, 2026-09-26: this section was originally spliced in BEFORE §11's own closing
"Not changed here" paragraph above, which pushed that paragraph to the end of the file, after
this section's own content, and left §11 appearing to end without it. It is now properly
appended after §11, as the file's next numbered section. No wording in §11's paragraph or in
this section's own text changed -- only its position moved back to where it belongs.)*

Implements `docs/overnight/DECISIONS.md` R7's `#29` bullets on top of R7/R8's exposure amendment
(§10) and the #10 peer-reference amendment (§11): the centralized normal-read eligibility rule
DESIGN.md §9 describes, `listNodes`'s default view, and the terminal-successor supersede
question the #29 reopen comment and `.tmp/understand/analysis-29.json`'s fix plan B named as
still open after exposure alone. §§1-4 and §§6-11 above are unchanged. **§5 is not**: point 2
below replaces §5's definition of `eligible`, it does not merely add to it -- see point 2 for
exactly what changed and why.

**1. Centralized eligibility.** New module `app/server/src/publication/service.evaluateNodeEligibility.ts`
exports `evaluateNodeEligibility(reader, workspace, nodeId, asOf)`, which resolves the node, its
head revision and its own terminal `supersede_log` event (if any) and returns
`{eligible, reasons, head_revision_id, lifecycle}`. `reasons` is a subset of `["retired",
"superseded", "inactive", "not_yet_valid", "expired"]`, evaluated against DESIGN.md §9's five
predicates (authorized workspace and accepted current revision are the caller's own resolution;
`is_active`, the `[valid_from, valid_to)` window at `asOf`, and "not replaced or retired" are
decided here). The validity window is HALF-OPEN: valid AT `valid_from`, no longer valid AT (not
after) `valid_to`. The module is write-free (AC4): it only ever reads `nodes`, `node_revisions`
and `supersede_log`.

A sibling module, `app/server/src/publication/service.terminalEventsFor.ts`, exports the batch
helper `terminalEventsFor(reader, workspace, ids[])`: one `supersede_log` query per PAGE (`old_id
IN (...)`), not one per node, shared by `listNodes`, `getAcceptedHead`, `listAcceptedHistory`,
`supersedeNode`'s successor check, `reconcileSearchChunks` and `indexRevisionChunks`.
`evaluateNodeEligibility` itself calls it. *(Fix round correction, 2026-09-26: both functions
originally lived together in one `service.evaluateEligibility.ts` file, which broke this
package's "one exported function per file, named after the file" rule -- the only file under
`publication/service.*.ts` that did. Split into the two files named above; no behaviour
changed.)*

**2. `getRecallEligibility` gains `reasons`; `eligible` REPLACES its §5 meaning, `witness_event_id`
does not.** `witness_event_id` keeps its exact §5 meaning. `eligible` does **not**: fix round
correction, a prior version of this section claimed it did, which is false. §5 defines `eligible`
as solely "no `supersede_log` row exists with `old_id = node_id`" -- a node "that has itself never
been superseded or retired is eligible regardless of" anything else. This section replaces that
definition with DESIGN.md §9's five predicates: a node with `is_active: false`, or whose head falls
outside its `[valid_from, valid_to)` window at `as_of`, is now ineligible even with zero
`supersede_log` rows. This is a disclosed, deliberate behaviour change, not an additive one --
`reasons` is the additive part, `eligible`'s widened meaning is not.

Readers still take no clock in the sense §4 states it (the kernel is never the thing that SAMPLES
one): `evaluateNodeEligibility` never calls `Date.now()`, on any path. **`getRecallEligibility`
does**, on one path -- fix round correction, a prior version of this section (and matching source
comments in `service.evaluateEligibility.ts`, now split into `service.terminalEventsFor.ts` /
`service.evaluateNodeEligibility.ts`, and in `registry.ts`) claimed neither ever does, which is
false. The validity-window `as_of` is a plain argument the caller supplies --
`app/server/src/knowledge/registry.ts`, the one dispatch point HTTP and MCP both call through,
supplies real request time (`Date.now()`) explicitly on every live call, which is the intended one
place a clock enters this kernel's read path. But `service.getRecallEligibility.ts`'s own
`requestTimeMs` parameter is optional, with `const asOf = requestTimeMs ?? Date.now();` -- so
`getRecallEligibility` itself also calls `Date.now()` whenever a caller omits the parameter. That
fallback exists purely so a handful of pre-existing generic in-process test harnesses (one argument
per call) keep working; none of them assert on `reasons`, so the difference is invisible to them,
and every LIVE call goes through the registry's explicit value, never the fallback -- but the
fallback is real code that runs, not a hypothetical, and this document should not have said
otherwise.

**3. `getAcceptedHead` / `listAcceptedHistory` gain `lifecycle`, additively.** `null` when the node
carries no terminal event, else `{event_id, kind: "retired"|"superseded", new_id, new_revision_id,
reason, superseded_at}` -- the same shape §9's "no event-kind column" rule already describes,
decoded once. Both methods remain direct-read/history surfaces: a retired or superseded node stays
readable here exactly as before, now labelled instead of indistinguishable from an active one.

**4. `listNodes`'s default view excludes retired and superseded nodes; `total` is amended.**
This is the breaking, closed-grammar change R7 calls for. `parseListNodes` gains a new required
key, `include_inactive: boolean` (closed, like every other key on this request -- there is no
default for an omitted key). `false` (ordinary use) excludes a node with its own terminal
`supersede_log` event; `true` is history mode and includes it, with an additive `lifecycle_state:
"active"|"retired"|"superseded"` and `new_id` on every row (not just the terminal ones).

This is a narrower filter than eligibility's five predicates on purpose: `is_active` and the
validity window live inside `node_revisions`, so unlike the retired/superseded predicate (an exact
set-subtraction over two native counts, below) there is no native way to count them without reading
every candidate revision -- precisely the full-materialize-to-fake-a-total this kernel already
refuses for `type_term` (§"type_term filter" in `service.listNodes.ts`). Rather than make `total`
lie or silently degrade to an approximation, `listNodes`'s default filter stays scoped to
"replaced or retired," and `is_active`/the validity window stay additive-only, surfaced through
`getRecallEligibility`'s `reasons` and the `lifecycle` label above. **This is a deliberate,
disclosed narrowing of the brief's fuller "inactive head, outside validity window" phrasing**, not
an oversight -- the reasoning is the paragraph above: no native, join-free way exists to count
`is_active`/the validity window exactly, and this kernel refuses to fake an exact total with a full
scan the way it refuses one for `type_term`.

*Fix round 2 correction, 2026-09-26 (R7, `docs/overnight/DECISIONS.md`).* The paragraph above
originally said `include_inactive` was a new REQUIRED key, "closed, like every other key on this
request -- there is no default for an omitted key." That broke the in-repo daily-loop alias
(`app/cli/kb.aliases.ts`'s `nodes list`, documented at `app/README.md`'s `bun app/cli.ts nodes list
--bank example --limit 20`) and any other caller built against the pre-#29 grammar: none of them
ever sent this key, so every call was refused `invalid_request`. The ruling itself only ever
required the DEFAULT to exclude retired/superseded nodes -- "`listNodes` excludes retired and
superseded nodes by default" -- not that every caller assert that default explicitly, and a
required key with no default cannot express a default at all. `include_inactive` is now OPTIONAL:
omitted means `false` (the same ordinary "current" view described above), present still means
STRICTLY boolean (an explicit `include_inactive: null` is refused `invalid_request`, not treated as
omitted -- "optional" changes only whether the key may be absent, never what it may hold once
present). Every caller that already sent the key explicitly (`app/ui/v2/src/api/listing.ts`) is
unaffected. The alias itself gains a `--history` flag mapping to `include_inactive: true`; without
it, the alias sends the exact five-key body it always has, byte-for-byte.

**`total` (amending PRs #99/#100's frozen "native, predicate-scoped count" semantics
at `service.listNodes.ts`):** with `include_total: true` and `type_term: null`,
- `include_inactive: true` (history mode): unchanged, `count(nodes, scope)`.
- `include_inactive: false`, INCLUDING omitted (default, fix round 2): `count(nodes, scope) -
  count(supersede_log, scope)`. This is an EXACT identity, not a scan-and-count: `old_id` is
  scoped-unique (`writeLifecycleEventFresh`'s `already_terminal` rule) and every event names a node
  that exists in the same workspace (`invalid_reference` refuses any other), so
  `count(supersede_log, scope)` is precisely the number of terminal nodes in scope. Two native
  counts, no join, no row read.
- `type_term` set: unchanged, `null` (no native scoped count exists for a JSON-embedded field).

`app/ui/v2/src/api/listing.ts`'s `listNodes` sends `include_inactive` on every call in the SAME
change (the closed-key rule turns a missing key into `invalid_request`, which the UI would show as
an empty list -- `listing.ts`'s own comment already documents exactly this failure mode for
`type_term`/`include_total`). The EXPLORE node list defaults to `include_inactive: false`; a new
"show history" toggle sets it `true`.

**5. Search-chunk read paths never treat a terminal node as ordinary.** `reconcileSearchChunks`
gains an additive `ineligible` count: a retired or superseded node visited on a page is counted
there, never under `missing` and never added to `missing_revisions` -- its absent chunks are not a
backfill gap, they are correctly-absent superseded/retired content (DESIGN.md:1119, "stale vectors
never present superseded content as current truth"). `indexRevisionChunks` refuses a terminal node
outright, returning `{outcome: "ineligible", reason: "retired"|"superseded"}` -- a returned value,
the same shape this method already uses for `"already_satisfied"`/`"indexed"`, never a thrown
reference fault (the node reference is valid; only its lifecycle state is refused).

**6. Superseding into an already-terminal successor is refused.** `supersedeNode` now refuses, as a
returned conflict (never thrown, matching `stale_pin`/`already_terminal`/`operation_digest`'s own
shape): `{outcome: "conflict", reason: "successor_terminal", row: null}` when `new_node_id` already
carries its own terminal `supersede_log` event (retired, or itself already superseded by something
else). Checked once the successor reference itself has resolved (after `/new_node_id`'s existence
and its head-revision pin, both unchanged from §1), and AFTER classification (§2) already ran, so a
byte-identical replay of a request accepted before the successor became terminal still returns
`idempotent` with the originally retained row -- the same "classification outranks later state"
rule §2 states for the pin and the forward-chain walk. `LifecycleWriteOutcome`'s conflict `reason`
union gains `"successor_terminal"` alongside the three existing values.

*Fix round correction, 2026-09-26.* The first version of this check lived entirely in
`service.supersedeNode.ts`, running before `writeLifecycleEventFresh` was ever called -- meaning
it ran before THIS request's own `/node_id` and `/peer_name` even resolved, and broke §11's frozen
precedence in exactly the way §11 states for peer references: "a caller naming a node [or peer]
that does not exist is told there is a conflict, as if the node existed." It now runs inside
`writeLifecycleEventFresh`, immediately after the `/peer_name` check §11 describes -- so a
nonexistent `/node_id`, a `/peer_name` that resolves nowhere, or a `/peer_name` that resolves only
in another workspace are each still told their OWN problem first. This does **not** reorder
`successor_terminal` relative to `stale_pin`/`already_terminal`: `successor_terminal` still runs
BEFORE those two, exactly as it always has (the successor's own pre-existing `/new_node_id`
existence and `/new_revision_id` match checks have likewise always run before this node's
`stale_pin`, unchanged) -- only its position relative to `/node_id` and `/peer_name` moved. See
`app/server/test/lifecycle-supersede-terminal-order.test.ts`, red against the original placement,
green after the move.

**Not changed here.** §§1-3 (identity, replay, conflict classification) and §7 (the closed error
code set: no new thrown code was needed; every new refusal above is a returned value) stand exactly
as before. §8's ownership/recovery/precision bullet is **corrected above, not left standing** --
*fix round 2, 2026-09-26*: it previously claimed no test lane existed for any of the three; that was
already false when this section was first written, and this section had re-affirmed the false claim
instead of fixing it (`.tmp/understand/analysis-29.json` fix plan B7).

**Evidence.** `app/server/test/lifecycle-eligibility.test.ts` (new): default exclusion and
history-mode labelling with the amended `total`, across a page boundary; the validity window at a
controlled `as_of`; superseding into an already-retired and an already-superseded successor, both
refused with no side effect on the refused caller's own eligibility; `reconcileSearchChunks`/
`indexRevisionChunks` on a terminal node. All red on `99a576d` before this slice (missing
`include_inactive` fails closed-grammar `invalid_request`; `reasons`/`ineligible` fields absent; a
terminal successor was silently `accepted`; an `is_active: false` head still read `eligible:
true`). `app/server/test/list-nodes-service.test.ts`, `list-pagination-isolation.test.ts`,
`lifecycle-ownership.test.ts` and `search-chunk-recovery.test.ts` were updated for the new required
key and the two additive fields their existing assertions pin exactly.

**Fix round evidence, 2026-09-26.** `lifecycle-supersede-terminal-order.test.ts` (new): red against
the original successor_terminal placement (a nonexistent `/node_id` returned `successor_terminal`
instead of `invalid_reference`), green after the move described under point 6 above; also proves
`successor_terminal` still legitimately outranks `stale_pin` once the reference issues are ruled
out. `lifecycle-eligibility-window-boundary.test.ts` (new): pins the exact `[valid_from, valid_to)`
half-open boundary instants (a mutation flipping either comparison operator now fails), and the new
non-finite-`as_of` guard in `service.evaluateNodeEligibility.ts` (red without the guard: a `NaN`
`as_of` silently read as eligible; green with it: refused `invalid_request`).
`lifecycle-eligibility-ac1.test.ts` (new): #29 AC1, a `correction`-typed node and a `corrects` link
into another node's accepted revision are ordinary content, not lifecycle events, and change
nothing about eligibility -- untracked by any test before this round.

**Fix round 2 evidence, 2026-09-26.** `app/server/test/list-nodes-service.test.ts` (new): red on
this round's HEAD before the fix (a `listNodes` request with no `include_inactive` key at all
raised `PublicationError{code: "invalid_request", path: "/include_inactive"}`), green after --
omitting the key now behaves exactly like an explicit `include_inactive: false`; a companion test
pins that an explicit `include_inactive: null` is still refused, proving "optional" did not also
mean "any type accepted." `app/server/test/lifecycle-eligibility.test.ts` (new): the same red/green,
this time through the gated writer with a real retired node, proving the omitted-key default
actually excludes retired/superseded content end-to-end, not just that parsing succeeds.
`app/cli.test.ts` (new): `nodes list --history` maps to `include_inactive: true`; the pre-existing
`nodes list` alias test (unchanged assertion, now the fix-round regression pin) proves the alias's
wire body without `--history` is byte-for-byte identical to what it always sent -- this is the
`invalid_request` regression the verifier measured on the alias's real HTTP/MCP path, now closed.

## 13. Amendment 2026-09-26 (overnight R18 (K3 + K4 + V6 + list/reflect))

Implements `docs/overnight/DECISIONS.md` R18 and `docs/overnight/V3-PARITY.md` §5's K3 ("term
filter on `listNodes`") and K4 ("time order on `listNodes`"), dispatched to the v3-list slice.
§§1-12 above are unchanged; this section only widens `listNodes`'s own request/response grammar
(§12 point 4), the same section R7's `include_inactive` amendment already lives in.

**Why now, together.** `oracle_list`/`oracle_reflect`/`oracle_inbox`/`oracle_recap` (the v3-compatible
adapter's V6 slice) all need to ask for "entries carrying this tag" and "newest first" without a
second, adapter-side full scan-and-sort of every page `listNodes` already returns -- the "applied
after the page, within the kernel's scan window" degraded behaviour `V3-PARITY.md §4.3` originally
designed `oracle_list`'s `type` filter and its `order_changed` warning around. K3 and K4 remove
both: the filter and the order both happen INSIDE the kernel's own bounded scan, exactly where
`type_term` and `include_inactive` already happen.

**1. K3 -- `all_term_ids` / `any_term_ids`.** Two new keys on `parseListNodes`, next to
`type_term`, following the SAME "optional key, admitted only when the caller sends it" idiom §12
point 4's fix round already established for `include_inactive` -- NOT the "required-but-nullable"
shape `V3-PARITY.md §5`'s table first sketched, which would have broken every caller that predates
this amendment (`oracle_list`'s own V2-degraded callers included) the exact way a required
`include_inactive` already did once. Omitted means no filter; present means a nonempty,
duplicate-free array of at most 20 (`MAX_FILTER_TERM_IDS`) nanoid21 term ids -- an empty array or an
explicit `null` is `invalid_request`, never a second spelling of "omitted" (the same rule
`include_inactive: null` states).

- `all_term_ids`: every listed id must be assigned on the candidate's CURRENT head revision.
- `any_term_ids`: at least one listed id must be assigned.
- Both read `node_revisions.term_snapshot_json` (`service.snapshotTermIds.ts`, the general form
  `service.deriveNodeType.ts` already specializes to the reserved `type` entry) -- never a live
  `node_revision_terms` join, for the identical reason `type_term` already avoids one: that
  projection lags `reconcileRevisionAssociations` and would silently miss every unreconciled node.
- Combined with each other (AND) and with `type_term` (AND); `all_term_ids` is itself AND across its
  own ids, `any_term_ids` is itself OR.
- `include_total` stays `null` whenever either is set, for the same reason it already does for
  `type_term`: term assignment lives in JSON text, not an indexed column, so an exact count would
  mean materializing and parsing every candidate revision -- the full scan this kernel already
  refuses to run just to fake a total.
- `PEER_FIELDS` (`knowledge/registry.peerFields.ts`) is unchanged: `listNodes` still binds no peer
  field, so this amendment asserts none rather than adding one.

**2. K4 -- `order` and `after_updated_at`.** A new optional `order` key, `"id_asc"` (the ORIGINAL,
unchanged keyset order, and the default when omitted) or `"updated_desc"` (`nodes.updated_at`
descending). A new optional `after_updated_at` key completes the `updated_desc` keyset PAIR
alongside the existing `after_id`: present only when `order` is `"updated_desc"` (refused under the
default order, since it would silently do nothing there), and the two travel together -- both
`null` (the first page) or both non-null (a continuation); one set without the other is
`invalid_request`, a half-specified cursor rather than a value this kernel guesses at.

- A single-column SQL `ORDER BY updated_at` makes no promise about how it breaks a tie on that
  column, so `updated_desc` always widens the scan window to `MAX_SCANNED_NODES` (like a
  `type_term`/`all_term_ids`/`any_term_ids`/`include_inactive:false` filter already does) and then
  re-sorts that window, in this process, to a deterministic `(updated_at desc, id asc)` order --
  the SAME pair the keyset boundary predicate excludes by (`updated_at < X OR (updated_at = X AND id
  > afterId)`). This is exact within one window; a tie wider than `MAX_SCANNED_NODES` (an
  improbable number of nodes sharing one stored microsecond) is the same disclosed, bounded-scan
  trade-off `MAX_SCANNED_NODES` already states for a rare `type_term` value.
- The response gains an additive `next_after_updated_at: string | null`, alongside `next_after_id`:
  the second half of the pair, `null` in `id_asc` mode and whenever the page exhausts the workspace.
- `after_updated_at`'s wire shape is the exact same UTC-millisecond text `rows.ts`'s
  `timestampToMicros` accepts; a malformed value is this request's OWN `invalid_request`, never the
  stored-row `integrity_failure` the same bytes would raise read back off a row.

**Not changed here.** The `id_asc` order's own predicate, page-boundary and `total` semantics
(§12 point 4) are byte-identical to before this amendment for a caller that never sends `order`,
`after_updated_at`, `all_term_ids` or `any_term_ids` -- every one of those keys is additive and
optional. No new table, no schema change, no new registry entry (`listNodes` is already registered).

**Evidence.** `app/server/test/list-nodes-service.test.ts`'s `"listNodes: all_term_ids / any_term_ids
filter (K3)"` and `"listNodes: order (K4)"` describe blocks: red on this round's HEAD before this
change (every new key was an unrecognized field, `invalid_request` from `closedKeys`), green after --
including a real tie (two nodes published under the identical instant) walked, one row per page, to
prove the `(updated_at desc, id asc)` tie-break is deterministic and the keyset pair skips and
repeats nothing across a page boundary.

## 14. Amendment 2026-09-26 (overnight R18 (K3 + K4 + V6 + list/reflect)) — fix round

An independent Opus verifier refuted §13's K4 claim and one of its citations. Both are
corrected here, append-only, per `docs/overnight/DECISIONS.md` R18; §13 itself is left
exactly as written.

**1. The K4 tie-break was wrong, not just under-scoped.** §13 point 2 and the code
comment it quoted both said the only risk was "a tie wider than `MAX_SCANNED_NODES`". That
is false. The bug was not a window too narrow for a wide tie — it was that a
SINGLE-column `ORDER BY updated_at DESC LIMIT n` makes no promise about WHICH members of a
tie group sitting at the `LIMIT` cutoff are the ones the engine actually returns. Re-sorting
the already-fetched window afterward (what §13's code did) cannot recover a row that was
never fetched at all: MEASURED on this stack, two strictly-newer rows sharing a 3-row scan
window with a 3-way tie beneath them was already enough to permanently drop two of the
three tied rows — a tie no "wider" than the window, combined with unrelated rows crowding
the same window from above. Plausible on a migrated corpus, since the copy migration (#34)
copies epoch-ms `updated_at` directly, and unrelated nodes routinely share a scan window
with a genuine tie.

**The fix**: `service.listNodes.ts`'s `updated_desc` branch now asks the storage adapter
for a COMPOUND order, `(updated_at desc, id asc)`, instead of a single column — the same
shape `mcp/calls.ts`'s own `(created_at desc, id desc)` order already uses for the identical
reason. `id` is a nanoid21 primary key, so this pair is a genuine total order with no ties
left for the engine to break arbitrarily: "the first `scanLimit` rows in this exact total
order" is unambiguous, and `LIMIT` can only cut at a row boundary, never through a tie
group. `DatasetAdapter.orderedProjection`'s `ordering` parameter is additive-widened to
accept either one column or an array of them; every other caller still passes a single
column and is byte-identical.

**Evidence.** `app/server/test/list-nodes-tie-edge.test.ts` (new file): red on this fix
round's pre-fix HEAD (a 3-way tie plus two newer rows, walked with a page size equal to a
narrowed scan window, returns 3 of 5 rows and reports the walk as complete), green after.
The narrowed scan window is a documented test-only 3rd argument to `listNodes`
(`scanWindowForTests`), never sent by any production caller, so `MAX_SCANNED_NODES` itself
is unchanged and the boundary is reachable without publishing 1000+ nodes.

**2. Citation correction.** §13's Evidence paragraph names `list-nodes-service.test.ts` for
the K3/K4 `describe` blocks it quotes; they are in `list-nodes-term-order.test.ts` (split
out for the 500-line-per-file cap, exactly as this file's own §9-era splits were). This
file is itself 548 lines as of §13, over the 500-line style guideline for CODE files; since
this is a descriptive, append-only CONTRACT document rather than a source file, and the
project rule forbids rewriting a frozen section to shrink it, splitting is left as a future
housekeeping task rather than done here mid-fix-round.

**3. V6 tool upgrades in this same round**, for completeness (`docs/overnight/V3-PARITY.md`
§2.5, §4.3, §7):
- `oracle_list`'s `type:"all"` (v3's own documented default value) is treated as "no
  filter", matching an omitted `type` — it was previously looked up as a `legacy_type` NAME,
  found none, and silently returned an empty page.
- `oracle_list`'s `asOf` now returns `unsupported_argument`, per §4.3, instead of being
  read nowhere.
- `oracle_recap`'s whole tool result is now the markdown STRING itself (v3 parity, §2.5),
  not a JSON object wrapping one; its own warnings (and `dispatchLegacyV3.ts`'s generic
  ones, e.g. `cwd`) travel as a plain-text footer on that same string, the only channel a
  string-shaped result has. `maxTokens` is accepted and named `argument_ignored`.
- `oracle_reflect` now samples the K3 `legacy_type:principle` pool alongside `learning`,
  closing the gap §7's "V6 upgrades oracle_list, oracle_reflect" line named and this round's
  verifier found undisclosed.
