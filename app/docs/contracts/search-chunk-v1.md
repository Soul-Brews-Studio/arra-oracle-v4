# Search chunks v1

Status: **DESCRIPTIVE CONTRACT**, written against shipped code. This document records what
`app/server/src/publication/search-chunk.ts` and the search-chunk methods on the context
writer/reader facades in `app/server/src/publication/service.ts` actually do, proven by
`app/server/test/search-chunk-service.test.ts`. Where the implementation and an intuitive
expectation disagree, the implementation is what is recorded here.

Parent `Soul-Brews-Studio/arra-oracle-v4#30`. Base `f600636` — all five kernels integrated,
full suite 766/0 green.

Physical schema, `storage.ts` (`search_chunks_v1`, exact order):

`id utf8 NOT NULL, workspace_name utf8 NOT NULL, node_id utf8 NOT NULL, revision_id utf8 NOT
NULL, chunk_index int64 NOT NULL, text utf8 NOT NULL, content_hash utf8 NOT NULL,
chunker_version utf8 NOT NULL, embedding_profile utf8 NOT NULL, embedding
fixed_size_list<float32?>[384] NULL, type_term_id utf8 NOT NULL, term_ids list<utf8?> NOT
NULL, observer_peer_name utf8 NULL, subject_peer_name utf8 NULL, session_name utf8 NULL,
status utf8 NOT NULL, attempts int64 NOT NULL, last_attempt_at timestamp[us] NULL, embedded_at
timestamp[us] NULL, error_code utf8 NULL`. Nineteen columns.

## 1. The frozen embedding dimension — MEASURED, not configured

`embedding` is `fixed_size_list<float32?>[384]`. The dimension **384 is frozen by the column
type itself** — it is a fact about the physical Arrow schema, not a per-row or per-profile
setting. A caller declaring `embedding_profile.dims` as anything other than `384`
(`EMBEDDING_DIMENSION`) is refused at the request-grammar boundary, before ever reaching a
writer: `dims !== 384` is `invalid_value` at `/embedding_profile/dims`. `dims` is validated
and then **dropped** — only `embedding_profile.name` becomes the stored `embedding_profile`
text; the frozen dimension is a fact about the one physical column, not a value the schema
has anywhere to hold per row.

**Embedding is deliberately off the authoritative write path.** `indexRevisionChunks` writes
every row with `status: "pending"` and `embedding: null`. No model call, no network call, and
no code path in this kernel ever populates `embedding` with a real vector — a separate,
**not-yet-implemented** method is the only thing authorized to do that. The stored-row codec
(`encodeSearchChunkRow`) reflects this: `storedEmbeddingMustBeNull` accepts **only** an
explicit `null` in that column and refuses anything else as `integrity_failure`, because this
codec has no authority to invent a float-array validation it never has to serve. `embedding`
is validated for shape even though it is never emitted on the wire — a corrupt embedding
column is still stored corruption whether or not a reader ever sees it. It is **omitted**
from the encoded wire object entirely (never emitted as `null`): the contract is "omitted or
null on the wire," and omission is the unambiguous choice — a caller checking `"embedding" in
row` gets a real answer rather than one that depends on which sender produced it.

`status` has **no enum declared in the physical schema** — `CHUNK_STATUSES = ["pending",
"ready", "failed"]` is this module's own closed set. `"pending"` is the only value this
module's own writer ever produces; `"ready"` and `"failed"` are reserved for the
not-yet-implemented embed step, validated here only so a future writer and this reader agree
on vocabulary. A stored value outside the set is `integrity_failure`, because a differently
configured writer could legally store a fourth value the schema itself does not forbid.

## 2. `term_ids` — the one list column

`term_ids` is `list<utf8?> NOT NULL` — **the only list-typed column in the entire schema**.
The list itself is required; each element is nullable by the physical type, though this
writer never stores a null element. The stored-row codec (`storedTermIds`) decodes it by
accepting either a real JS array or an **Apache Arrow `Vector`-like object exposing
`toArray()`** — it does not assume which shape the measured decode path actually produces,
because unlike every scalar column in this package, a list column does not automatically
round-trip through `decodeArrowRows` as a plain JS array. Readback-comparison logic elsewhere
in the service (`sameEncodedValue`) is array-aware for exactly this reason: every other
readback comparison in the package uses a bare `!==`, which is correct for scalars but would
never agree for two distinct array references holding the same term ids.

`term_ids` (and `type_term_id`) are copied from the revision's **own immutable term
snapshot** (`term_snapshot_json`) at index time — never from a live join against
`node_revision_terms`, which is a derived, rebuildable projection. These are therefore
**stale-able copies**: a caller filtering `search_chunks_v1` on `term_ids`,
`observer_peer_name`, `subject_peer_name`, or `session_name` is filtering a snapshot that can
drift from the revision's *current* term assignments, and this is explicitly **never an
authorization substitute** — those copied columns exist for search convenience, not for
re-deriving access control.

## 3. Request grammar

```
indexRevisionChunks {workspace_name:W, node_id:N, revision_id:N,
                      chunker_version:"chunker/v1", embedding_profile:{name:W, dims:384}}
reconcileSearchChunks {workspace_name:W, limit:1..1024}
listSearchChunks       {workspace_name:W, revision_id:N, chunker_version:"chunker/v1",
                        embedding_profile:S(<=256B)}
```

`chunker_version` is **not free text** — it must be the exact literal `"chunker/v1"`
(`CHUNKER_VERSION`), refused as `invalid_value` otherwise. This is because `chunker_version`
is a content-derived identity input: it keys both the chunk id derivation and the idempotency
check. An unvalidated string here would let a caller label v1 output as `"chunker/v2"`, and a
real future v2 implementation deriving the same ids for that label would then treat v1's rows
as `already_satisfied` forever — rejecting anything but the one label this module actually
runs keeps the label and the code that produced it permanently in agreement.

`reconcileSearchChunks.limit` is capped at `MAX_RECONCILE_REVISIONS` = 1024, a small JSON
integer, matching the bounded-sweep documentation in section 5.

## 4. Deterministic identity — the entire idempotency mechanism

Chunk ids are **deterministic**: `sha256HexWithDomain("arra-search-chunk-id/v1",
JSON.stringify([revision_id, chunker_version, embedding_profile.name,
chunk_index.toString(10)]))`. There is **no operation journal** for `indexRevisionChunks` —
none is needed, because retrying the same request for the same
`(revision_id, chunker_version, embedding_profile)` always proposes the identical set of ids.
`indexRevisionChunks` is explicitly **re-callable** for the same revision under a different
`chunker_version` or `embedding_profile` — that plurality is exactly what the id derivation
keys on, and it is why every scoped read (`listSearchChunks`, the reconcile sweep's presence
checks) always scopes on all three of `(revision_id, chunker_version, embedding_profile)`
together, never `revision_id` alone: scoping on `revision_id` alone would merge rows from
unrelated indexing runs and sort `chunk_index` — unique only within the full three-part scope
— as if it were a non-unique key, which cannot support a stable ordering.

Chunking itself (`chunkText`) is a **fixed-size deterministic** chunker by UTF-16 code units
(`CHUNK_SIZE_CHARS` = 1000), not a semantic chunker — the smallest thing that gives every
revision a stable, reproducible chunk boundary set. An empty derived text still produces
exactly one (empty) chunk, so a revision with empty text still gets one addressable row
rather than none. A naive `slice` boundary could split a UTF-16 surrogate pair (e.g. an emoji
straddling a multiple of 1000); the chunker nudges such a boundary one code unit forward so
the pair stays intact in the earlier chunk — otherwise the eventual UTF-8 encode would replace
the lone surrogate with U+FFFD, corrupting `text` and making `content_hash` (computed on the
pre-corruption string) permanently unreproducible from the stored bytes.

`type_term_id`/`term_ids` are derived once per `indexRevisionChunks` call from the accepted
revision's own term snapshot. `publishRevision` requires **exactly one** reserved-type term
assignment before a revision is ever accepted, so an accepted revision snapshot yielding zero
or more than one reserved-type assignment here is stored corruption
(`integrity_failure`), never a caller mistake — `indexRevisionChunks` distinguishes 0 / 1 / >1
rather than silently taking the first or last match.

## 5. Write path and idempotency classification

`indexRevisionChunks` resolves the workspace, the node, and the **accepted** revision
(`selectAcceptedRevision`; `invalid_reference` at `/revision_id` if it does not resolve),
derives the full target set of physical rows (one per chunk), then queries existing rows
scoped to `(workspace, revision_id, chunker_version, embedding_profile)`:

- **Every target id already present** → `{outcome: "already_satisfied", rows}` — no write.
- **Otherwise** → only the **missing** ids are appended (`toWrite`), never a full rewrite of
  ones already present; the readback step then re-fetches and field-compares **every**
  target, including ones that were already present before this call, against the freshly
  built expected row. A field mismatch on readback (for either a newly written or a
  pre-existing row) poisons and returns `recovery_required`.

This is the **one write path in the whole kernel that hand-constructs Arrow buffers directly**
rather than going through the shared `writeRow` helper's row-shape assumptions — which is
exactly the kind of construction that could silently write the wrong value (e.g. an
out-of-range bigint landing as a different in-range one), so the full per-field comparison on
readback is not optional here the way it might be for a simpler append.

`embedding` is excluded from the per-field readback comparison loop (there is nothing to
compare — it is never emitted by the codec — but its shape is still validated inside
`encodeSearchChunkRow` as part of that call succeeding at all).

## 6. Reconciliation — a deliberately bounded sweep, not a predicate

**"An accepted revision with no chunk row at all" is not expressible as a predicate over
`search_chunks_v1`** — absence of a row is not a queryable condition against that table. To
answer this question `reconcileSearchChunks` walks the *other* side of the relationship
instead: this workspace's `nodes`, each already bounded to its own accepted head, checking
each head's chunk rows — rather than scanning the chunk table for what it does not contain.

The sweep is bounded at `MAX_RECONCILE_REVISIONS` (1024) nodes per call, matching the request
grammar's own cap, and is **not pageable**: `visited` is always the first `limit` node ids in
ascending order, so a second call with the same or a smaller `limit` re-visits the **same**
nodes rather than advancing. `exhausted` (`fetched.length <= request.limit`) tells a caller
whether this call saw every node in the workspace, but there is **no cursor field** to carry
forward when it did not — a workspace with more than `MAX_RECONCILE_REVISIONS` nodes is **not
fully reconcilable through this method today**. A caller over the cap gets a partial,
always-identical answer, distinguishable from a complete one only via `exhausted: false`, with
no way to reach the remainder in a subsequent call.

For each visited node: `missing` counts nodes whose accepted head has **zero** chunk rows for
any indexing run (a `present.length === 0` check with `limit 1`, scoped only on
`revision_id` — deliberately not also scoped on chunker/profile, since the reconcile question
is "was this revision indexed at all," not "under this exact chunker/profile"), and each
missing case is recorded as `{node_id, revision_id}`. `stale` counts nodes where chunk rows
survive under the node for a revision that is **no longer** the accepted head
(`node_id` matches, `revision_id != <current head>`). **Stale rows are never deleted or
reclaimed by this method — it only reports.**

## 7. Reads and bounds

`listSearchChunks` returns every chunk row for one exact `(workspace, revision_id,
chunker_version, embedding_profile)` scope, sorted by `chunk_index` ascending — a real total
order because `chunk_index` is unique within that three-part scope (section 4), never a
tie-break over a non-unique key. This is a **materialized-table read only**: it says nothing
about whether the underlying revision is still the accepted head, still exists, or was ever
retired — a caller needing that guarantee resolves the revision separately (e.g. through the
node lifecycle or association kernels) before trusting these rows. A cumulative wire budget
(matching `listMessages`'s convention) is enforced: exceeding it fails the whole call with
`limit_exceeded` — it never truncates a page, which would otherwise hand back a short page
indistinguishable from a complete one.

## 8. Errors

Reuse the governed `arra-error/v1` codec for raw grammar faults. Persistence/state faults
reuse `arra-publication-error/v1`'s closed code set: `invalid_request`, `invalid_reference`,
`integrity_failure`, `writer_unavailable`, `unsupported_dataset`, `recovery_required`,
`limit_exceeded`. `not_found` is **excluded**.

## 9. What this slice does NOT claim

- **No embedding is ever produced or stored by this kernel.** Every row this writer produces
  is `status: "pending"`, `embedding: null`. There is no model call, no network call, and no
  claim that a "pending" row will ever transition to "ready" — that transition belongs to a
  separate, not-yet-implemented method.
- `term_ids`/`type_term_id`/`observer_peer_name`/`subject_peer_name`/`session_name` are
  stale-able snapshot copies, never live joins, and **never an authorization substitute**
  (section 2).
- `reconcileSearchChunks` is a bounded, non-pageable sweep — not a complete audit above its
  cap, and it never reclaims stale rows, only reports them (section 6).
- **Ownership, recovery and precision test lanes do not exist for this kernel.** Only
  `search-chunk-service.test.ts` (core behavior) exists. Queue-exclusion-under-contention,
  poison-both-directions, kill-after-write recovery, and a dedicated Arrow-buffer /
  fixed-size-list precision sweep beyond what the core test exercises are not covered by any
  test file today — a real, disclosed gap.

## 10. Places code and expectation disagreed

- It would be natural to expect `dims` to be a genuinely configurable per-profile setting;
  it is validated and then thrown away. The schema has exactly one embedding column, of one
  frozen width, and `dims` exists purely as a request-time assertion that the caller's
  expectation matches that frozen fact.
- `term_ids` decoding as an Arrow `Vector` rather than a plain array is not obvious from the
  declared TypeScript type (`list<utf8?>` reads like "an array of strings") and required the
  codec to explicitly support both shapes rather than assume the one that looks natural from
  the schema string alone.
- "Reconcile for missing chunks" sounds like a predicate query; it is implemented as an
  inverted, bounded walk over nodes specifically because the natural query ("do any nodes
  lack a chunk row") cannot be expressed as a predicate over the chunk table itself.

## 11. Amendment 2026-09-26 (overnight R7 (exposure part) + R8 (HTTP/MCP part))

`listSearchChunks`, `indexRevisionChunks`, `writeChunkEmbedding` and `reconcileSearchChunks`
had no transport route: `knowledge/registry.ts` deliberately excluded the search-chunk
kernel, so all four answered HTTP 404 (measured: `.tmp/understand/issue-30/issue30.test.ts`'s
`REPRO T0 transport-exposed chunk/search methods: []`) and no `kb_*` tool existed on
`tools/list`. `docs/overnight/DECISIONS.md` R7 rules that kernel code no client can call is
not #30-done, and R8 both keeps the full HTTP+MCP+CLI contract for #31 **and** rules
explicitly that `indexRevisionChunks`, `reconcileSearchChunks` and `writeChunkEmbedding` are
exposed under `content:write` (not internal-only), specifically so an external embed worker
can run the index-first/embed-later backfill Nat asked for.

All four are now registry entries at `scopePath: []` (`workspace_name` sits at the request
root in every parser above) — `listSearchChunks` at `content:read`; `indexRevisionChunks`,
`writeChunkEmbedding` and `reconcileSearchChunks` at `content:write` per R8. This amendment is
reachability only: it does not add retrieval (`searchChunks` does not exist — section 5/#30's
own fix plan calls that out as still-missing), does not add the embedding-profile registry,
and does not change `reconcileSearchChunks`'s measured under-counting of `stale` or its
missing profile-scoping (section 6, section 10). A caller reaching this kernel over a
transport gets exactly the same partial completeness guarantees this document already
documents when the kernel is called directly.

Proof: `app/server/test/knowledge-expose13-registry.test.ts` (registry shape),
`app/server/test/knowledge-expose13-transport.test.ts` (HTTP 404→200, the four `kb_*` tools
on `tools/list`, read/write authorization refusals, against a fake bundle calling this file's
own real parsers), and `app/server/test/knowledge-expose13-live.test.ts`
(`indexRevisionChunks` → `listSearchChunks` → `writeChunkEmbedding` → `reconcileSearchChunks`
round-tripped over both HTTP and MCP against a real writer-gated target-19 dataset, using two
distinct indexed nodes — one over each transport — since a `pending` chunk row cannot be
re-embedded, so an idempotent replay is not the right proof for `writeChunkEmbedding`).

## 12. Amendment 2026-09-26 (overnight R7 (#29 part))

**What changed.** §5 and §6 are amended: a retired or superseded node is no longer treated as an
ordinary node by either write path.

- `indexRevisionChunks` (§5) now resolves the target node's own terminal `supersede_log` event
  (via `service.terminalEventsFor.ts`, one query, immediately after the node reference itself
  resolves and before the revision is selected) and, if one exists, refuses outright with
  `{outcome: "ineligible", reason: "retired"|"superseded"}` — a returned value, the same shape
  this method already uses for `"already_satisfied"`/`"indexed"`, never a thrown reference fault:
  the node reference is valid, only its lifecycle STATE is refused.
- `reconcileSearchChunks` (§6) now resolves the whole visited page's terminal events in one
  `old_id IN (...)` query (the same batching §6 already required for everything else on that
  page) and counts a terminal node under a new, additive `ineligible` field, separate from
  `missing`/`stale`: its absent chunks are never added to `missing_revisions`. §6's own
  `missing`/`stale` counting is otherwise unchanged.

**Why.** DESIGN.md:1119, "stale vectors never present superseded content as current truth."
Indexing a retired or superseded node's content, or reporting its absent chunks as a backfill
gap (`missing`), would let stale or newly-produced vectors stand in for current truth after a
node has been explicitly replaced or withdrawn. `docs/overnight/DECISIONS.md` R7's `#29` bullets
require this centralized normal-read eligibility rule (DESIGN.md §9) applied everywhere a node's
lifecycle state is relevant to a read or a write, not only at `listNodes`/`getRecallEligibility`.

**Not changed here.** §5's write path, idempotency mechanism and readback comparison are
unchanged for a NON-terminal node. §6's `missing`/`stale` definitions, its bounded/non-pageable
sweep shape, and its measured gaps (§9, §10 — `stale`'s undercounting relative to a differently
migrated dataset, and its lack of profile-scoping) are unchanged. #30's own missing piece — *(fix
round 2 correction, 2026-09-26: this previously read "§30", a section-mark typo for issue #30)* —
filtering retrieval at query time for a terminal node's chunks that were written before it became
terminal — is explicitly **not** addressed here: `indexRevisionChunks` refuses NEW indexing of a
terminal node, but chunks already written before retirement/supersession stay in
`search_chunks_v1`, and `reconcileSearchChunks` no longer reports them as stale either (they
belong to a node this sweep now skips entirely on the `terminal.has(nodeId)` branch). This is a
disclosed gap for the not-yet-landed search-query slice to close, not a claim that superseded
content is unreachable through every path today.

**Evidence.** `app/server/test/lifecycle-eligibility.test.ts`'s "search-chunk read paths never
treat a terminal node as ordinary" test: `reconcileSearchChunks` reports a retired node as
`ineligible`, never `missing`; `indexRevisionChunks` on the same node returns `{outcome:
"ineligible", reason: "retired"}`. Both red on `99a576d` (a terminal node's absent chunks
counted as an ordinary `missing` gap; indexing one silently succeeded).

## 13. Amendment 2026-09-26 (overnight R7 (#30 part) + R14)

**Change.** The target-19 tier gains its first retrieval: two `content:read` methods on the
context READER facade only, registered in
`app/server/src/knowledge/registry.ts`, so HTTP (`POST /api/knowledge/:bank/<method>`), MCP
(`kb_<method>`) and the CLI (`kb <method>`, plus `search --mode keyword|semantic`) all reach
the same entry. Section 11's "`searchChunks` does not exist" is superseded: retrieval exists
under the names below, which follow the registry's verb-first naming (`listSearchChunks`,
`getRecallEligibility`).

- `searchKnowledgeKeyword` — `{workspace_name, query, limit?}`.
- `searchKnowledgeSemantic` — `{workspace_name, query, limit?, embedding_profile?}`.

*(Integration merge, 2026-09-27: both methods are READER-only, under the rule that
`chat-v1.md`'s R9 amendment set for `answerChat`: a read never opens a writer.
`service.createSearchService.ts` builds them over the gateless reader's adapter, and
`openEvidenceReader` / `openContextReader` put them on the reader's context facade. The
trusted query embedder is handed to the reader (`composition.ts` → `createKnowledgeAccess({embedder})`
→ `openEvidenceReader(root, {embedder})`), and it is never a writer option. No writer facade
carries either search. The writer keeps only the keyword index MAINTENANCE, in
`indexRevisionChunks` (below). The branch as first written spread both methods onto every writer
facade and threaded the embedder through writer options; the merge removed that. Pinned by
the ownership tests' facade lists (`session-link-ownership.test.ts`: writer 28 methods, reader
18; 30 and 19 once section 14 added `embedPendingChunks` and `getSearchFreshness`) and by
`search-chunk-retrieval.test.ts`'s `writerContextMethods`.)*

Grammar (strict parser, closed keys; an optional key is admitted only when present, the
`requester_peer_name` idiom): `query` is kept verbatim (no trim, fold or NFC), must hold a
non-whitespace character (`invalid_value` at `/query`) and is capped at 4096 UTF-8 bytes
(`limit_exceeded`); `limit` is a JSON integer 1..50, default 10, absent or null meaning the
default. Keyword search takes no `embedding_profile` (`unexpected_field`): chunk text is
identical under every profile. Semantic `embedding_profile` is the stored profile NAME (the
`listSearchChunks` spelling, not the index-time `{name, dims}` object); absent or null means
the profile of the composed query embedder (below).

**Answers are nodes, and only current, recall-eligible ones.** Candidates are chunks; each
candidate survives only when (1) its `revision_id` is its node's captured head
(`nodes.current_revision_id`) — a chunk of an earlier revision is stale however well it
matched; (2) for keyword search, the head revision's WHOLE text contains the query (below);
(3) the node is recall-eligible, decided by calling the public `getRecallEligibility` kernel
method per node (`service.recallEligibleNodeIds.ts`), so retired and superseded nodes never
surface (DECISIONS.md R18 D3); (4) every read is scoped to the request's workspace, the
candidate query included. A node's surviving chunks collapse into ONE hit
`{node_id, revision_id, title, snippet, chunk_ids, ...}`: `title` is the head revision's;
`snippet` is a 160-code-point window, for keyword of the head text around the first
case-folded occurrence, for semantic of the node's nearest chunk; `chunk_ids` are the head
revision's examined candidate chunk ids by `chunk_index`. The copied `term_ids`/session
columns are never consulted: a stale-able projection is not a lifecycle or authorization
source (section 2 stands).

**Keyword** (`{match, scan_reason, hits[{..., score, match}]}`). The contract is: the node's
head text — `title`, a blank line, `body` (`chunkSourceText`, exactly the string
`indexRevisionChunks` cuts into chunks) — contains `query`, case-folded (`containsFolded`).
It is checked on that text, never on one chunk, so an occurrence cut by the
1000-code-unit chunk boundary, or a query longer than a chunk, is an answer.

- `match: "ngram"` — an FTS index on `search_chunks_v1.text` built from the SHARED
  `FTS_INDEX_OPTIONS` (`app/server/src/fts/fts.constants.ts`: `ngram` 3..3, no stemming, no
  stop-word removal — R14), the same constant the legacy `memories` index is built from. The
  query is a `MatchQuery`, whose terms are OR-ed (measured: `หลงลืม` returns a chunk holding
  only `งลืม…`), so every chunk that holds three or more code points of an occurrence is a
  candidate, in BM25 order. Trigram over-matches are removed in two steps. First the
  chunk-local pre-filter (`chunkMayHoldQuery`, below) drops a chunk that can hold no part of an
  occurrence, which already removes an over-match lying inside one chunk (หลงทาง vs หลงลืม).
  Then the whole-head-text check decides every node that is left. Only that check can refuse
  an over-match cut at a seam: for ความทรงจำ, a full chunk ending `ความ` passes the pre-filter,
  because it may be the first half of a cut occurrence. If the next chunk starts `รัก`, the
  head text holds every trigram of ความทรงจำ but not the word, and the node is refused. `score`
  is the node's best chunk score; order is score descending, then node id.
- The seam case: a query of 3 or 4 code points can be cut so that neither chunk keeps a
  trigram of it (หล|ง, wx|yz), and the index cannot see it. When the index answers fewer than
  `limit` nodes, a seam scan adds them: non-first chunks that start with a proper suffix of the
  query (`seamPredicate`), re-checked the same way. Those hits carry `match: "substring_scan"`
  and `score: null` inside an `ngram` answer, and rank after every scored hit, by node id.
- `match: "substring_scan"`, `score: null` — a bounded, escaped `ILIKE` scan in node-id order,
  when the query is under 3 code points (`scan_reason: "short_query"`; a trigram index has
  nothing to look up and would answer `[]` silently) or when the index is absent or is not the
  governed config (`scan_reason: "index_unavailable"`; measured on 0.38.0: a never-indexed
  table answers FTS with `[]`, not an error, and an `icu` index would give `icu` answers).
  SPEC §4.1.2: "fall back to LIKE and say so". The scan crosses seams too
  (`keywordScanPredicate`): under 6 code points, the whole query or a seam clause; from 6 on,
  the query is cut into one more piece than the chunk boundaries an occurrence can cross (they
  are at least 1000 code units apart), so one piece lies whole in some chunk.
- Before any read, `chunkMayHoldQuery` drops candidates no occurrence can touch: a chunk
  qualifies only by containing the query, by ending with a proper prefix of it when a seam
  follows (full-length chunk), by starting with a proper suffix when a seam precedes
  (`chunk_index > 0`), or by lying inside it. Its fold writes final sigma as σ, so a chunk-local
  fold never hides what the whole-text fold finds.
- Every round is bounded by the one shared overfetch loop (`fts/fts.overfetch.ts`,
  `FTS_CANDIDATE_FACTOR`/`FTS_CANDIDATE_CEILING`): an answer is short only when the source ran
  dry or 4096 candidates were examined.

**Who builds the index (writer-gate rule).** Readers never create, rebuild or repair an index;
they only read `listIndices()`. The WRITER does, in `indexRevisionChunks`: every successful
call — `indexed`, or an `already_satisfied` replay — is followed by an index step that leaves
exactly one FTS index on the text column, kept as-is when its live `indexDetails` already
match (no rebuild, no new version), rebuilt under its own name when they differ, and rebuilt
over every row once the rows appended since its build reach the rows it covers
(`fts.refreshStaleFtsIndexOn`). An `ineligible` refusal (section 12: a retired or superseded
node) writes and verifies nothing, so it has no index step. LanceDB still finds unindexed rows (measured), so staleness
costs speed, never answers; the refresh keeps at most half the table unindexed at O(1)
amortized rebuild work per row. The index step is its OWN turn in the owner's serialized
queue, queued right after the write turn, with no write attempted in it. New failure mode: if
the build fails, the call answers `writer_unavailable` (503); the chunk rows are already
durable and the owner is NOT poisoned (the next publication and index call are served); a
replay repeats only the index step. If the owner stops serving between the two turns (closed,
or poisoned by another request), the call still answers the rows it verified, and the next
owner's index call builds the index. A dataset whose chunks predate this amendment is scanned
(`index_unavailable`) until any `indexRevisionChunks` call, a replay included, builds it.

**Semantic** (`{embedding_profile, metric: "l2_squared", hits[{..., distance}]}`): the query is
embedded by a trusted, injected `QueryEmbedder {profile, embed}` (composition: `embed.ts` over
local Ollama; tests: a stub). The composition names the profile from `EMBEDDING_MODEL`, blank
or unset meaning `DEFAULT_EMBEDDING_PROFILE = "all-minilm"`, and calls Ollama with that SAME
name as the model, so the profile a search reports cannot differ from the model that embedded
its query. *(Integration merge, 2026-09-27: section 14 A's registry replaced this pairing. The
profile is the active profile id, `ollama/<model>/384/none`, and the model is that profile's
`model`; `DEFAULT_EMBEDDING_PROFILE` no longer exists. See section 14's merge note.)* A
request naming no profile reads the embedder's own; a request for a profile the embedder does
not serve is `invalid_value` at `/embedding_profile`, before any model call —
vector spaces are never mixed. No embedder, a throw, no answer within 30 s, or a vector that
is not 384 finite float32 values is `writer_unavailable` (503). That was `chat.ts`'s
`mapModelFailure` choice when this slice was built; since then #32 / R9 has moved chat to its own
`model_unavailable`. This search keeps `writer_unavailable`, the code its tests pin, and adds
no code to the closed set. Aligning the two is an open decision. Candidates are
`status = 'ready'` chunks of that profile and `chunker/v1`, flat L2 search with the workspace
predicate as a prefilter; `distance` is LanceDB's `l2`, the SQUARED Euclidean distance,
reported as stored (measured: orthogonal unit vectors give 2). Pending and failed chunks have
no vector and are never candidates. The `status = 'ready'` predicate does not rely on that: a
chunk that keeps a stored vector but is not `ready` is refused too. No product writer makes
such a row today; the test makes one by surgery. One table holds several profiles, as built (R7); a chunk
of another profile is never a candidate. Order is distance ascending, then node id. Keyword and
semantic answers are never fused (R7: fusing measured worse than either alone in relic's
evaluation).

**Reason.** `docs/overnight/DECISIONS.md` R7 (#30 part: keyword and semantic retrieval are
separate methods; the chunk index is `ngram(3,3)` from one shared options module; one table
holds several embedding profiles) and R14 (the shared `FTS_INDEX_OPTIONS`, the
under-3-code-point scan that says so, substring post-verification). #30's acceptance "Support
ICU keyword and separate semantic retrieval; validate canonical lifecycle/permissions after
candidate retrieval" is met here with `ngram` in place of `icu`, per R7. R8 keeps the legacy
CLI `search` (default `--mode text`) unchanged; the knowledge search is `--mode
keyword|semantic`.

**Still NOT claimed.**

- No freshness report (unindexed-row count, pending/failed per profile). *(Integration merge,
  2026-09-27: section 14 B's `getSearchFreshness` is that report.)*
- A first build over a large pre-existing chunk table, and each refresh rebuild, runs in the
  owner's serialized queue: publications queued behind it wait for it.
- The seam scan is a workspace-scoped scan (`chunk_index > 0` plus one escaped prefix clause per
  cut position, 2 or 3 of them), not an index lookup: a 3-4 code point query whose index answer is short of `limit`
  pays it, in the same way a query under 3 code points pays the short-query scan.
- BM25 `score` comes from one index shared by every workspace, and the raw number is returned.
  The answer SET is workspace-scoped, but the score VALUE depends on every workspace's text, so
  a caller can observe another workspace's term statistics. Measured by the verifier on a live
  gated server: one workspace's score for `หลงลืม` fell from 5.65 to 2.38 after a second
  workspace indexed 12 nodes holding it, with the same hit set. The legacy path exposes `score`
  the same way. The fix is Nat's decision (a per-workspace index, no `score`, or rank only), so
  this amendment leaves it open.
- `writeChunkEmbedding` rewrites the chunk row (`mergeInsert`), so after an embedding backfill
  most rows can sit outside the text index until the next `indexRevisionChunks` call triggers
  the refresh. Answers are unchanged, because LanceDB still searches unindexed rows; only speed
  is affected.
- No embedding-profile registry: `DEFAULT_EMBEDDING_PROFILE` and the composition's
  profile/model pairing are the seam a registry replaces. *(Integration merge, 2026-09-27:
  replaced by section 14 A's registry.)*
- Eligibility is `getRecallEligibility`'s rule, reached through one seam,
  `service.recallEligibleNodeIds.ts`. *(Integration merge, 2026-09-27: after #29 slice B
  (section 12, lifecycle-v1.md's amendment) that rule is DESIGN.md §9's predicates: no terminal
  `supersede_log` event, `is_active`, and the `[valid_from, valid_to)` window. The window's
  `as_of` is the transport's request time: the registry passes `Date.now()` to both searches,
  as it does to `getRecallEligibility`, and one value serves a whole request. This closes
  section 12's disclosed gap: a terminal node's chunks written before it became terminal are
  never answered. Proof: `app/server/test/search-chunk-retrieval-validity.test.ts`, both searches
  at the half-open boundary instants and through the registry route.)* The per-node call costs
  several scoped reads per candidate node; it runs last, only for nodes whose head text already
  matched.
- The `reconcileSearchChunks` gaps of sections 6 and 10 are unchanged.
- No retrieval-quality number (#7).

Proof: `app/server/test/search-chunk-retrieval-grammar.test.ts` (grammar, snippet window, the
pre-filter's seam rules and a cut-position property, the scan predicate, total hit order),
`app/server/test/search-chunk-retrieval.test.ts` (real gated dataset: the inside-word Thai
case, the หลงทาง false positive removed (there, by the pre-filter), the 2-code-point scan,
retired / superseded / stale-revision / other-workspace / pending chunks never surfacing, a
chunk that keeps a vector but is not `ready` never a semantic candidate, the candidate query itself
scoped (a spying adapter), stable order and bounded limit, the reader never building the
index while the writer builds and repairs it, squared-L2 ranking over stub vectors, a node
indexed only under another profile never answering, the default profile being the
embedder's, profile mismatch and embedder failure),
`app/server/test/search-chunk-retrieval-straddle.test.ts` (occurrences cut by a chunk
boundary, a 1100-character query and its 999-character prefix, a query only the title holds,
and the seam over-match above (ความ|รัก for ความทรงจำ), which a spying adapter shows is a
candidate on both paths and which only the whole-head-text check refuses, all on the index
and on the scan), `app/server/test/search-chunk-retrieval-index-maintenance.test.ts` (a real index-build
failure answers `writer_unavailable` without poisoning the owner, a replay repairs it, the
refresh keeps unindexed rows below indexed ones),
`app/server/test/search-chunk-retrieval-live.test.ts` (publish → `indexRevisionChunks` →
`writeChunkEmbedding` → both searches over HTTP and MCP, same answers on both, a seam-cut
occurrence found on both, cross-workspace credential refused, beta's identical text never in
alpha's answer), and `app/server/test/cli-search.test.ts` (bare `search` stays legacy;
`--mode keyword|semantic` reaches the registry route).

## 14. Amendment 2026-09-26 (overnight R7 (#30 part) + R8 + R20 (embedding digest pin, below))

*(Integration merge, 2026-09-27: this amendment was written on a branch cut before sections
12 and 13 landed; it keeps its own content and takes the next number. Where the two meet, the
merge decided as follows. (1) Section A's registry replaces section 13's
`DEFAULT_EMBEDDING_PROFILE` seam: that constant is gone, the composed query embedder's profile
is `activeEmbeddingProfileId()` and it embeds with the active profile's own `model`, and a
semantic search naming no profile reads the active id. Section 13's refusal of a profile the
embedder does not serve is unchanged; its parser still takes any well-formed name. (2) Every
server-side index request names the active id too: the v3 adapter's `indexProfile()`
(`knowledge/transport.indexProfile.ts`) and the migration's `deriveProjections` used the bare
model name, which section A refuses. (3) The embed worker's embedder is a WRITER option, named
`documentEmbedder` (`ContextOptions`, `KnowledgeDatasetConfig`) apart from section 13's
READER-only query `embedder`: `embedPendingChunks` writes vectors, so it runs on the writer,
while no search and no chat call ever opens one (R9). `composition.ts` composes the chat
model, the query embedder, the document embedder and R20's digest probe. (4)
`getSearchFreshness` is a read: it is in `createContextReadMethods`, so it is on every reader
facade and, like every read, spread onto every writer facade; the registry routes it to the
reader. `embedPendingChunks`, `indexRevisionChunks`, `writeChunkEmbedding` and
`reconcileSearchChunks` are writer-only. The ownership tests pin 30 context methods on a
writer facade and 19 on a reader facade. (5) Section B's `ineligible` is section 12's field:
the merged `reconcileSearchChunks` keeps section B's accounting and reads the page's terminal
events in section 12's single `terminalEventsFor` query. (6) Section 13's writer builds the
text index inside every successful `indexRevisionChunks` call, so section B's
`text_index` is real numbers from the first indexed chunk on, and `null` only for a table with
no lexical index, such as a dataset whose chunks predate section 13.)*

Slices A (embedding-profile registry), B (`reconcileSearchChunks` correctness and
`getSearchFreshness`), C (`embedPendingChunks`, the embed worker) and R20 (the embedding model
digest pin), per `docs/overnight/DECISIONS.md` R7, R8 and R20. This corrects §1's and §9's
"not-yet-implemented" language about the embed step and supersedes §6's description of
`reconcileSearchChunks`; the sections above are left unedited as the historical record. It
replaces two earlier drafts of this amendment on the same unmerged branch, whose boot-time
digest pin R20 rejected (see "Review history" at the end).

### A. The closed embedding-profile registry

`search-chunk.profiles.ts` declares ONE active profile, `ACTIVE_EMBEDDING_PROFILE`:
`{profile_id, provider: "ollama", model, dims: 384, normalization: "none", document_prefix: "",
query_prefix: "", input_rule: "chunker/v1:title\n\nbody"}`, where `model` is
`EMBEDDING_MODEL ?? "all-minilm"` — the same variable and default `embed.ts` embeds with.

`profile_id`, the string stored in every row's `embedding_profile`, is
`ollama/<model>/384/none` (default `ollama/all-minilm/384/none`). It is configuration only: it
contains no measured value, so nothing a running server observes can change it (R20, below).

An `embedding_profile` other than the active id is `invalid_value`: at `/embedding_profile/name`
for `indexRevisionChunks` (before the frozen-384 `dims` check) and at `/embedding_profile` for
`listSearchChunks`. R7's "one table holds several embedding profiles, as built" is about the
physical schema: a row written under a retired or pre-registry profile id is never deleted and
stays physically present; only a REQUEST naming a non-active profile is refused.

### R20. The model digest is part of the profile identity

The profile's identity is the pair (`profile_id`, the model digest pinned for it in this
dataset). `profile_id` never carries the digest, because rows are indexed before anything is
embedded, and an id that followed the digest would change the moment the first measurement
arrived. The digest half is pinned per dataset and enforced on every embed run.

1. **Pin record.** `<dataset root>/.embedding-profile-pins.json`:
   `{"version": "arra-embedding-pins/v1", "pins": {"<profile_id>": {"digest": "<64 hex>",
   "pinned_at": "<ISO-8601 UTC>"}}}`. It is a sidecar file, not a LanceDB table (Python owns the
   schema). It is keyed by `profile_id`, so a changed `EMBEDDING_MODEL` starts its own pin. It is
   written atomically (temp file, then `rename`), never overwritten and never created by boot,
   and the writer creates no directories. A file that exists but cannot be read, carries another
   `version`, or holds a digest outside `^[0-9a-f]{64}$` is `integrity_failure` for both
   `embedPendingChunks` and `getSearchFreshness`. A damaged pin is never read as "not pinned".
2. **Measurement.** `GET {OLLAMA_URL}/api/tags`, the `models[]` entry whose `name` or `model`
   is `EMBEDDING_MODEL` or `EMBEDDING_MODEL:latest`, and its `digest`. Only a 64-lowercase-hex
   value counts. Each probe is bounded by `ARRA_EMBED_DIGEST_TIMEOUT_MS` (default 2000 ms; a
   value that is not a finite positive number falls back to it), enforced by the caller's own
   timer. Unreachable, timed out, non-2xx, no matching model, or an unrecognisable digest all
   read as **unmeasured**. **Measured correction to R20's wording**: R20 and the brief name
   `/api/show`. Measured 2026-09-26 on m5 against a real Ollama serving `all-minilm`, that
   response has no `digest` field (top-level keys: `license`, `modelfile`, `parameters`,
   `template`, `details`, `model_info`, `capabilities`, `modified_at`). `/api/tags` carries it
   (`all-minilm` was `1b226e2802dbb772b5fc32a58f103ca1804ef7501331012de126ab22f67475ef` there
   that day), so the probe reads `/api/tags`.
3. **Every `embedPendingChunks` run** follows these steps after the grammar and workspace
   checks and before it reads any candidate row:
   - **Probe.** If the digest is unmeasured, the call returns
     `{attempted: 0, embedded: 0, reused: 0, failed: 0, remaining: <eligible rows>, skipped: 0,
     blocked: "digest_unmeasured"}`. There is no embedder call and no row change: no row is
     marked `failed` and `attempts` is untouched. No pin is written.
   - **Measured but different from the pin.** The call throws `embedding_profile_mismatch`
     naming both digests. Nothing is embedded or written.
   - **Measured and equal to the pin, or nothing pinned yet.** The run proceeds.
   - **Probe again after the embedder returns vectors,** before the write turn. Anything other
     than the same digest (a build swapped during the call, or no answer) returns
     `blocked: "digest_unmeasured"` and writes nothing. No single digest covers those vectors.
   - **Inside the write turn, before any write,** the pin is re-read (a concurrent run may
     have pinned in the meantime); a different pin is `embedding_profile_mismatch`. If nothing
     is pinned and this turn will write at least one vector (a fresh embedding or a
     content-hash reuse), the run's own measured digest is pinned immediately before the first
     vector write. A run whose rows all fail or are all skipped pins nothing. A pin that cannot
     be written is `writer_unavailable`, and no vector is written.
   - With no digest probe configured (`ContextOptions.digestProbe` /
     `KnowledgeDatasetConfig.digestProbe` absent), every run is `blocked: "digest_unmeasured"`.
     `composition.ts` wires the `/api/tags` probe; tests wire a stub.
4. **`embedding_profile_mismatch`** is a new closed code in `arra-publication-error/v1`,
   appended to `PUBLICATION_ERROR_CODES`. It maps to HTTP 409; MCP returns `isError` with the
   same envelope, and CLI `kb` prints it. The envelope is
   `{version: "arra-publication-error/v1", code: "embedding_profile_mismatch", path: "",
   message: "embedding model digest differs from the dataset's pinned digest", pinned_digest,
   measured_digest}`. The two digest fields exist on this code only. They are the one exception
   to `revision-publication-v1.md` §8's four-field envelope. The message stays a fixed literal,
   and both digests passed `^[0-9a-f]{64}$` before use, so the reason for fixed messages (no
   caller text, paths or SDK internals) still holds. Resolution is an operator's deliberate
   re-index (item 8), never a retry.
5. **Boot** (`runStartupIndexWork`, `composeKnowledgeAccess`, `buildApp`) never probes the
   model, never pins, and never changes a profile id.
6. **No flip, ever.** `profile_id` never changes, and no row's `embedding_profile` is ever
   rewritten. Rows indexed while the digest was unmeasured are exactly the rows a later
   measured run embeds.
7. **`getSearchFreshness.vectors.model_digest`** is `{pinned, last_measured}`. `pinned` comes
   from the pin file and is `null` until the first vector is written. `last_measured` is what
   the most recent `embedPendingChunks` probe in THIS server process measured for this dataset.
   It is `null` before any run in this process, or when that probe could not measure. Both are
   dataset-wide, because one pin covers the whole profile. `pinned != last_measured` (both
   non-null) is exactly the state in which embed runs refuse.
8. **Re-indexing is an operator act.** No API changes a pin. To adopt a new model build, an
   operator re-indexes under a new profile deliberately. One way is to set `EMBEDDING_MODEL` to
   a distinct name or tag: that is a new `profile_id`, pinned separately by its own first embed
   run, after which `indexRevisionChunks` and `embedPendingChunks` are re-run. The other way is
   to start a fresh dataset root. The old profile's rows stay physically present (R7) and are
   never listed under the new id. This slice ships no in-place re-pin tool.
9. **Outside R20's measurement.** `writeChunkEmbedding` (R8's external-worker path) stores a
   caller-supplied vector for an existing row. The server cannot measure what model produced
   that vector, so a `content:write` caller that uses it with another model can still mix
   vectors. This is a trust boundary of that method, stated rather than enforced.

### B. `reconcileSearchChunks` correctness

Presence is recomputed from the head revision's own title and body
(`chunkText`/`deriveChunkId`/`deriveContentHash`, the same derivation `indexRevisionChunks`
uses), not trusted from a row count. It is scoped to `(revision_id, CHUNKER_VERSION, active
profile)`, so a revision indexed only under a non-active profile counts as missing for the
active one. The response gains these fields:

- `incomplete`: a partial expected set; the revision still lands in `missing_revisions`.
- `hash_mismatch`: a present row whose `content_hash` no longer matches the recomputed one.
- `ineligible`: a retired or superseded node (`getRecallEligibility`'s own `supersede_log`
  check). It is excluded from missing, incomplete, hash_mismatch and stale accounting.
- `missing_source`: a chunk row belonging to no visited node, or whose `revision_id` is not any
  visited node's accepted head. It is global and bounded by the node sweep.
- `pending`/`ready`/`failed`: global counts for the active profile.

The `stale` probe now runs for every visited eligible node, including one whose head is itself
unindexed. The earlier `continue` skipped exactly that case. `missing`/`missing_revisions`/
`stale`/`visited`/`exhausted` keep their meaning and shape.

### B. `getSearchFreshness` (new, `content:read`)

It answers three stages, each from its own measurement, and keeps unknown distinct from zero:

- `content.nodes`/`content.revisions`: plain counts, always knowable.
- `text_index.indexed_rows`/`unindexed_rows`: from `DatasetAdapter.textIndexStats`. They are
  `null` when no lexical index exists yet on `search_chunks_v1.text`. LanceDB's `indexStats()`
  answers for the one shared table, with no per-predicate variant. So the figures are reported
  only when the requesting workspace holds every row currently in the table; otherwise both are
  `null`, never another workspace's numbers.
- `vectors.pending`/`ready`/`failed`: counts for the active profile. `vectors.last_attempt_at`
  is `null` when no row has been attempted. `vectors.model_digest` is R20 item 7.

### C. `embedPendingChunks` (new, `content:write`, per R8 on HTTP, MCP and CLI `kb`)

After R20's step 0 the run does four things:

1. It reads `pending` rows, and `failed` rows under `MAX_EMBED_ATTEMPTS` (5), for the active
   profile.
2. It tries content-hash reuse first: it copies an existing `ready` vector for the same
   workspace, chunker, active profile and `content_hash`, with no embedder call.
3. It calls the injected embedder for the rest, OUTSIDE `core.serial`, bounded by
   `ARRA_EMBED_TIMEOUT_MS` (default 30 s) with a timer. The response is validated before any
   write: the count, each vector's length against the frozen 384, and finiteness. An
   out-of-contract batch is `embedder_bad_response` for the whole batch.
4. It writes every outcome in ONE `core.serial` turn with `writeChunkEmbedding`'s
   update-then-verify-readback shape. Each row's `(status, attempts)` is re-read first, and a
   row another writer moved in the meantime is skipped, never overwritten.

The result is `{attempted, embedded, reused, failed, remaining, skipped, blocked}`. A failure is
a closed `error_code`: `embedder_unavailable` (no embedder configured), `embedder_timeout`, or
`embedder_bad_response`; `attempts` is incremented and `status` becomes `"failed"`.
`indexRevisionChunks` itself still never embeds, so §1's "embedding is off the authoritative
write path" holds. `composition.ts` wires `embed.ts`'s `embed()`, which now takes an optional
`AbortSignal` (after the `model` argument section 13 added: `embed(texts, model, signal)`), as
the writer's `documentEmbedder`.

### Proof

- `app/server/test/search-chunk-digest-pin.test.ts` covers R20 items 1, 3, 6 and 7, in gated
  children with a stub embedder and a scripted stub probe; each restart is a new process. It
  proves:
  - the first run pins, and an all-failed run pins nothing;
  - the same digest after a restart proceeds;
  - a changed digest is refused with the exact envelope: zero embedder calls, the row still
    `pending`/`attempts: 0`/`embedding: null`, pin and `profile_id` unchanged;
  - an unmeasured, hung or unconfigured probe blocks with zero vectors;
  - a digest that changes during the embedder call writes nothing;
  - a damaged pin file is `integrity_failure` for both `embedPendingChunks` and
    `getSearchFreshness`, with no embedder call and no re-pin;
  - unmeasured-then-measured across a restart embeds the same rows under the same
    `profile_id`.
- `app/server/test/search-chunk-digest-boot.test.ts` covers items 2, 4 and 5 through the
  production wiring (`runStartupIndexWork` and `composeKnowledgeAccess`, nothing injected)
  against a stub Ollama HTTP server. It proves:
  - boot makes zero requests and writes no pin file;
  - embed pins A;
  - a reboot against a healthy Ollama now serving B changes nothing, and the next embed
    refuses naming A and B;
  - boot 1 before Ollama can answer and boot 2 after keep one `profile_id`;
  - `fetchOllamaModelDigest` is bounded and ignores a non-hex digest.
- `search-chunk-reconcile.test.ts` and `search-chunk-reconcile-fixround.test.ts` cover section
  B. The `text_index` isolation case includes two workspaces that each own chunks.
- `search-chunk-embed-worker.test.ts` covers section C: a publish is never blocked (proved by
  a handshake), plus the write race, bad responses, retry, reuse, no embedder, the retry cap,
  and the full loop.
- `knowledge-expose13-transport.test.ts` covers admission for `getSearchFreshness` and
  `embedPendingChunks`.

Every search-chunk test that indexed under a free-text profile name now uses
`activeEmbeddingProfileId()`. *(Integration merge: so do section 13's retrieval tests, the
lifecycle and v3-adapter tests that index or list chunks, and the `indexProfile()` test. A
retrieval test that needs rows under a second profile plants them by harness surgery, the way
section B's tests plant a non-active profile row.)*

### Review history and known limits

An independent verifier refuted two earlier drafts on this branch.

- **Round 1** found five defects:
  - an unbounded boot digest probe;
  - an unpinned identity;
  - unvalidated embedder output that poisoned the writer;
  - a lost write race;
  - the `text_index` cross-workspace leak.

  It also found weak tests. The fixes for the last three stand as described in sections B and
  C.
- **Round 2** showed the boot-time pin failing both ways R20 names. A pinned dataset never
  re-probed, so a new build under the same name mixed vectors into the old profile. And
  unmeasured-then-measured boots still flipped `profile_id`. R20 replaces that design with the
  one above.

Known limits, disclosed rather than fixed:

- `missing_source` over-counts when `exhausted` is false and overlaps `stale`.
- `embedPendingChunks` also embeds rows of superseded revisions.
- `classifyEmbedError` maps a refused connection or a 503 to `embedder_bad_response`. An
  Ollama outage now blocks at the probe before any row is touched, so only an outage that
  starts between the probe and the embed call still consumes attempts.
- `text_index` is non-null exactly when the caller's workspace owns every chunk row, which
  tells a `content:read` caller whether any other workspace has indexed chunks (one bit).

## 15. Amendment 2026-09-26 (overnight R18 (V5) + R7 + R14)

v3-search slice (Claude Opus 5.5, AI); rulings in `docs/overnight/DECISIONS.md` R18 (V5, D3), R7, R14. Section 13 stands; this adds its first adapter consumer.

- The v3-compatible tools `oracle_search`, `oracle_ask` and `oracle_search_chain` (`app/server/src/mcp/legacy-v3/`) reach `searchKnowledgeKeyword`/`searchKnowledgeSemantic` through the same registry entries, parser and eligibility as HTTP and `kb_*`. `oracle_search` and `oracle_ask` consume answer ORDER only, never a `score` or `distance` value, so a change to the keyword `score` field does not change their contract. `oracle_search_chain` does read the semantic `distance` (squared L2 as stored, section 13): its v3 `score` is `1/(1+distance)`, a hop whose best falls under half the previous hop's stops the chain, and each result carries `distance`. A change to that field's meaning changes this tool.
- Both searches (and the two chat methods) exist on the reader only, as section 13 says. The adapter's `kb()` sends them to a reader even inside a `content:write` tool, from its own list (`mcp/legacy-v3/readerOnlyMethods.ts`), which a test pins to exactly the registry methods whose `call` refuses a writer bundle; the registry itself is unchanged. A `content:write` tool reaches them only when it also needs `content:read` (`authorization-integration-v1.md`, amendment "R18 (V5) + R7 + R14").
- The v3 adapter does not route recall to the legacy `memories` path: `oracle_learn` writes the target-19 tier, and splitting one fact across two writable stores is what V3-PARITY §4.4 forbids.

## 16. Amendment 2026-09-26 (overnight R18 (V2 read/supersede/verify) + D3)

Appended, not rewritten. Ruling: [`docs/overnight/DECISIONS.md`](../../../docs/overnight/DECISIONS.md)
R18/R20, `docs/overnight/V3-PARITY.md` §4.2 (`oracle_verify`).

**What changed.** `app/server/src/mcp/legacy-v3/tools/oracle_verify.ts` (new) is the first v3-compat
consumer of `reconcileSearchChunks` (§6 above). It maps v3's `verify` shape onto that one kernel:
`healthy = visited - missing - stale`, `missing`/`drifted` = the kernel's `missing`/`stale` counts,
`missing_documents` = `missing_revisions`, and a `partial` warning when `exhausted` is false.
`orphaned` and `untracked` are always `null`, named `field_unavailable`: this kernel has no concept
of either (nothing is ever deleted out from under a chunk row to make one "orphaned", and every
node is tracked by construction). `check:false` is `not_carried` (v3's version wrote a synthetic
`superseded_by:'_verified_orphan'`, inventing a lifecycle event this kernel never would); `type` is
accepted and ignored, named `argument_ignored`.

**GAP, named rather than approximated: no `getSearchFreshness` on this base.** R20 (embedding-digest
pinning: `getSearchFreshness` reporting the pinned and last-measured model digest) has not landed in
this checkout as of this amendment -- `rg -i freshness app/server/src` finds nothing. v3's `verify`
concept conflates two questions this v4 split into two kernels: "is every current node's text
indexed" (`reconcileSearchChunks`, wired here) and "is the embedding profile consistent"
(`getSearchFreshness`, R20, not yet present). `oracle_verify` answers only the first; it does not
invent a digest-freshness field, does not silently claim the embedding half is healthy, and does not
call a kernel that does not exist. When `getSearchFreshness` lands, `oracle_verify`'s `uses`/
`requires` and this section both need a follow-up amendment naming the added field(s).

**Not changed here.** No kernel file changed; `reconcileSearchChunks` itself is exactly as §6 and
§12/§13 above describe (visits every current node, reports terminal nodes as `ineligible` rather
than `missing`, reports and never reclaims stale rows).

**Evidence.** `app/server/test/mcp-v3-reads.test.ts` (new, failing-first: red before `oracle_verify`
existed, all three `oracle_verify` steps answering `not_yet_available`): a normal call's `healthy`/
`missing`/`drifted` are numbers, `orphaned`/`untracked` are `null` and named in `compat_warnings`,
`missing_documents` is an array; `check:false` answers `not_carried`; a `type` filter is accepted,
ignored and named `argument_ignored`.

## 17. Amendment 2026-09-26 (overnight R21 (search-polish slice) + R9 consistency)

Source: `docs/overnight/DECISIONS.md` **R21**, ruling on `Soul-Brews-Studio/arra-oracle-v4#30`
and `#10` (the search-polish slice). The sections above are left as written, including their
`score` and `writer_unavailable` wording, which described shipped code at the time; this
amendment records what changed and why. Where they disagree with this amendment, this
amendment wins.

### 1 · Keyword search never returns the raw BM25 score

The "Still NOT claimed" list above already measured the defect this closes: `search_chunks_v1`
has ONE FTS index shared by every workspace, so a raw BM25 `score` for an UNCHANGED hit set
moves when ANY workspace's corpus changes -- measured live at 5.65 → 2.38 after a second
workspace indexed 12 nodes holding the same term. The answer SET was already workspace-scoped;
only the score VALUE leaked another workspace's term statistics.

**What changed:** `searchKnowledgeKeyword`'s `hits[]` no longer carries `score`. Each hit
instead carries `rank`, an integer, 1-based, its position in THIS answer, in the exact order
`score` used to produce -- BM25 descending, a seam or scan hit after every scored one, ties (and
every unscored hit) broken by node id ascending. `match` is unchanged: `"ngram"` for an index
hit, `"substring_scan"` for a scan or seam hit. Every occurrence of `score` in sections above
(the keyword shape, the ordering rule, the seam-hit shape, the scan-path shape) reads `rank`
instead, with the same ordering guarantee and no null case -- every hit has a rank.

```
searchKnowledgeKeyword -> { match, scan_reason, hits: [{ node_id, revision_id, title, snippet,
                            chunk_ids, rank, match }] }   // was: ..., score, match }] }
```

**Why not a per-workspace index instead:** the "Still NOT claimed" list posed this as Nat's open
decision (a per-workspace index, no score, or rank only). A per-workspace index multiplies the
index count with every workspace and was not measured; dropping the score to a position costs
nothing extra to compute (the hits are already in that order) and removes the raw-score-VALUE
leak at no extra cost, so R21 takes it. It does **not** remove every cross-workspace leak this
index carries -- see 1.1, corrected in the fix round below. *(Fix round, 2026-09-27: the first
version of this line said dropping to `rank` "removes the leak completely." An independent
verifier showed that is false -- see 1.1. R21's own ruling text never made that claim; it says
only "a per-workspace index... would make the score local," i.e. rank-only does not. This
amendment is corrected to match the ruling, not the overstatement.)*

**Semantic search's `distance` is unaffected, and the claim is verified, not assumed:**
`distance` is LanceDB's `l2`, the squared Euclidean distance between the query's OWN embedded
vector and one stored chunk row's OWN vector. Both operands are per-row/per-request quantities;
the computation touches no aggregate over other rows, so no other workspace's data can appear in
the number regardless of what any workspace's corpus holds. This is a property of the vector
metric itself (unlike BM25, whose score is defined in terms of corpus-wide document frequency),
so no equivalent index-sharing measurement is needed to confirm it holds for every dataset shape.

**Proof (raw-score VALUE removal, single hit):**
`app/server/test/search-chunk-retrieval-score-isolation.test.ts`'s first `describe`,
failing-first against the unfixed code (a raw, moving `score` on the wire) and green after: two
workspaces, change ONLY workspace B's corpus (12 nodes repeating workspace A's search term,
indexed between the two searches), and workspace A's `searchKnowledgeKeyword` response for the
identical request -- ONE hit -- is byte-for-byte identical before and after. That byte-identity
claim does not generalize past one hit; 1.1 states what does. The existing suites
(`search-chunk-retrieval.test.ts`, `-straddle.test.ts`, `-live.test.ts`) were updated from
pinning `score` to pinning `rank`, the same way `#32` chat tests were updated off
`writer_unavailable` below.

#### 1.1 · What `rank` does NOT close: hit order and limit-bound membership stay shared

*(Added in the fix round, 2026-09-27, after an independent verifier refuted 1's original "removes
the leak completely" line.)* `rank` is a POSITION -- 1-based, in BM25 order. That order is
computed by the ONE FTS index every workspace shares, from corpus-wide IDF and average document
length. Removing the raw score number stops a caller from reading another workspace's term
statistics off that number; it does **not** stop another workspace's corpus from deciding the
ORDER between two hits that both genuinely belong to the requesting workspace, and therefore does
not stop it from deciding WHICH of that workspace's own nodes a bounded `limit` returns.

**Measured:** workspace ALPHA holds two nodes that both contain the query once -- A1 additionally
repeats the query's own `abc` trigram, A2 repeats its `def` trigram. Query ALPHA: `rank 1` names
A1. Workspace BETA then indexes 12 nodes that repeat ONLY `abc` (never the query string itself,
so BETA is never a candidate and never appears in ALPHA's answer). Query ALPHA again, same
request, nothing ALPHA wrote changed: `rank 1` now names A2. At `limit: 1` this is not a
reordering a caller can shrug off -- it is a different NODE coming back. This is the same shape
the original verifier measured (5.65 → 2.38 single-hit score move), one level up: a corpus write
in one workspace still steers what another workspace's bounded answer contains.

**What this means for the earlier claim:** the answer SET (which nodes CAN ever appear) stays
workspace-scoped -- BETA's own nodes never enter ALPHA's hits, in either test below. What is not
workspace-scoped is the ORDER over that set, and therefore, once `limit` is smaller than the set,
which of the workspace's OWN nodes survive the cut. "Removes the leak completely" was wrong;
"removes the raw-score value from the wire" is what shipped.

**Reverse (fully close this) by:** a per-workspace FTS index or per-workspace BM25 statistics
(R21's own "reverse by" line), or a workspace-local re-rank over the FULL set of a workspace's own
matching candidates rather than the shared index's top-K. Both are real engineering, out of scope
for this fix round, and Nat's call, not made here.

**Proof:** `app/server/test/search-chunk-retrieval-score-isolation.test.ts`'s second `describe`,
failing-first in the sense that it reproduces, deterministically, the exact residual leak above
(the assertion `expect(after).toEqual(before)` fails against current code with two ALPHA hits --
captured once during this fix round and reverted, not left in the suite as a permanently red
test); the committed version instead pins the HONEST, currently-true guarantee: the hit SET never
crosses a workspace boundary and the raw score never reaches the wire, while explicitly asserting
that hit ORDER between ALPHA's own two nodes flips when only BETA's corpus grows.

### 2 · Semantic search's embedder failure is `model_unavailable`, not `writer_unavailable`

The semantic paragraph above already named this as "Aligning the two is an open decision" once
`#32` / R9 gave chat its own `model_unavailable` code. R21 makes that alignment: no chat model
configured and no query embedder configured (or either failing) are the same KIND of outcome --
an external model this call depends on did not answer usably, nothing was read or written wrongly
-- so both now answer the one closed `model_unavailable` code (`arra-publication-error/v1`, HTTP
503, MCP `isError` carrying the same envelope; message `"chat model unavailable"`, the fixed
literal the code already carries for chat -- callers key off `code`, never `message`).

**What changed:** `service.embedSearchQuery.ts`'s three failure exits (no embedder composed, the
embed call throwing, rejecting or exceeding `QUERY_EMBED_TIMEOUT_MS`, or answering a vector that
is not exactly `EMBEDDING_DIMENSION` finite float32-representable numbers) now call
`failPublication("model_unavailable", "")` where they called `failPublication("writer_unavailable", "")`.
Nothing else in `searchKnowledgeSemantic` changed: the profile-mismatch refusal is still
`invalid_value` at `/embedding_profile`, decided BEFORE any model call, and every other section
above (candidates, ordering, eligibility) is unchanged.

```
searchKnowledgeSemantic, no/failed embedder -> 503 { code: "model_unavailable" }   // was: "writer_unavailable"
```

**MCP/CLI parity, not separately implemented:** both transports and the CLI already carry any
`PublicationError` through unchanged by its `.toJSON()` shape (`auth/service.ts`'s `runMcp`,
`knowledge/transport.ts`'s `knowledgeErrorResponse`, and the CLI's `search` command printing the
HTTP body verbatim on a non-2xx status). Changing the one thrown code was sufficient; no
transport-specific mapping needed updating.

**Proof:** `app/server/test/search-chunk-retrieval.test.ts`'s embedder-down case and
`app/server/test/search-chunk-retrieval-live.test.ts`'s HTTP/MCP embedder-down case now assert
`model_unavailable` (previously `writer_unavailable`).

### Caller impact

- A client reading `searchKnowledgeKeyword`'s `hits[].score` must read `hits[].rank` instead. The
  field is always present; there is no `null` case (the substring scan used to report `score:
  null`, and now reports its position like every other hit).
- A client that read `searchKnowledgeSemantic`'s `writer_unavailable` as "no model" should read
  `model_unavailable` (the same code `answerChat` already uses for the same reason).
- `hits[].match` and `hits[].distance` (semantic) are unchanged.
- A client relying on `rank` for cross-workspace isolation should read 1.1: the hit SET is
  workspace-scoped and the raw score is gone, but hit ORDER (and, at a bounded `limit`, which of
  this workspace's own nodes come back) is still decided by the shared index's corpus-wide BM25
  statistics.
- This amendment covers only `search_chunks_v1` / the two `#30` search methods. The legacy
  `memories` path (`db.ts`) still returns a raw BM25 `score` over its own ngram index, scoped only
  by `workspace_name` (`app/server/src/db.ts`) -- the "Still NOT claimed" bullet above already
  named this, and R21 did not rule on it. A caller of the legacy path has neither the VALUE fix
  nor the SET/order scoping this amendment describes.

## 18. Amendment 2026-09-26 (overnight Nat style: 350-500 lines per file)

Source: the overnight run's code-style rule (`docs/overnight/PLAN.md` §1, "Code style from Nat:
one function per file, 350–500 line cap per file") and `docs/overnight/DECISIONS.md`, under which
the style-split slice (2026-09-27) split a test file §12 cites as evidence. No ruling, behavior,
code or contract wording above changes — only where the cited evidence now lives on disk.

**What moved.** §12's evidence paragraph cites `app/server/test/lifecycle-eligibility.test.ts`'s
"search-chunk read paths never treat a terminal node as ordinary" test. That file had grown to
544 lines, over the cap, and is split in two by concern; this describe (with its
`reconcileSearchChunks`/`indexRevisionChunks`-on-a-terminal-node assertions, unchanged) moved
verbatim to a new file, `app/server/test/lifecycle-eligibility-enforcement.test.ts`, alongside the
lifecycle contract's own supersede-into-terminal-successor describe. Both old-name and new-file
suites were run before and after the split: `bun test test/lifecycle-*.test.ts` reports 35 pass /
0 fail / 416 `expect()` calls on both sides, identical — no test or assertion dropped. §12's
paragraph itself is left as written (frozen contracts are not rewritten); this amendment is the
correction.

## 19. Amendment 2026-09-26 (overnight R13 (CI must actually pass))

Appended; section C and its Proof bullet above are left as recorded. Ruling: [`docs/overnight/DECISIONS.md`](../../../docs/overnight/DECISIONS.md) R13.

**What changed.** Only how `search-chunk-embed-worker.test.ts` proves section C's "a hung embedder
never blocks a concurrent write". No kernel file changed; section C's four steps stand as written.

- The concurrent test asserted `publishResult.elapsedMs < 250` against a 300 ms embed timeout. It
  now asserts the publish SETTLED before the embed call (`settledSeq`, recorded by
  `fixtures/search-chunk-v1/embed/gated-embed.ts`). Its timeout claims are unchanged: `failed: 1`,
  `embedder_timeout`, elapsed at least 280 ms, and under `scaledMs(5000)`.
- The handshake test (the one that discriminates mutation M4, the embedder call moved inside
  `core.serial`) now HOLDS the embedder (`embedderMode: "hold"`): the stub answers only after the
  publish has settled, and records whether the service abandoned the held call first. It asserts
  the publish is accepted, `abortedWhileHeld` is false, the publish settled first, and the released
  call then embeds (`embedded: 1`, row `ready`). The timeout path's own assertions stay in the
  concurrent test.

**Why.** On the GitHub runner the publish took 351 and 324 ms (run 36265462602) and 260 ms (run
36268048901) with nothing wrong, and the same failure reproduced locally under CPU contention
(322-727 ms, 4/4 red). Settle order alone is not enough: under M4 the worker's write-back also
queues behind the publish, so the publish still settles first (measured, M4 passed 2/0). With the
held embedder, a publish that settles at all never waited for the embedder, at any machine speed.

**Evidence.** M4 applied to `service.embedPendingChunks.ts`: the handshake test is red
(`abortedWhileHeld: true`); reverted: 11/0 for the file. Under the same local contention after
the change, the criterion-1 tests passed; one loaded run failed earlier, inside `createFixture`, when
the Python exporter hit the then-unscaled 60 s child deadline, which R13's `scaledMs` now scales.

## 20. Amendment 2026-09-26 (overnight R22 (keyword order is workspace-local) + R21 + R14)

Source: [`docs/overnight/DECISIONS.md`](../../../docs/overnight/DECISIONS.md) **R22** ("Keyword hit
ORDER uses workspace-local signals only"), on `Soul-Brews-Studio/arra-oracle-v4#30` and `#10`;
it builds on R21 (`rank`, no raw score: section 17) and R14 (the case-folded substring contract:
section 13). Sections above are left as written. Where they disagree with this amendment, this
amendment wins, in particular section 13's "order is score descending, then node id", "rank
after every scored hit", "When the index answers fewer than `limit` nodes, a seam scan adds
them" and "Every round is bounded by the one shared overfetch loop" (for keyword search), section
17's "in the exact order `score` used to produce", all of 17.1.1, and 17's caller-impact bullet on
isolation. This section was revised in place in the R22 fix round, before it merged, after the
fix-round verifier refuted its first cut (section 2); sections 1-17 were not touched.

### 1 · What changed

`searchKnowledgeKeyword` still lets the ONE FTS index on `search_chunks_v1.text`, shared by every
workspace, pick candidate chunks: prefiltered to the workspace, read up to a ceiling (below), and
re-checked exactly as section 13 says. BM25 no longer decides anything about the ORDER. Every hit, whichever path found
it, is ordered by three facts about the node's current head revision in the requesting workspace
(`search-chunk.keywordHitOrder.ts`):

1. **occurrences** of the query in the head text (`chunkSourceText`: `title`, a blank line,
   `body`), descending. The count uses R14's own matching rule (`containsFolded`): both sides
   `toLowerCase()`d over the whole text. It counts left to right, non-overlapping (`"aaaa"` holds
   `"aa"` twice), in `fts/fts.countFolded.ts`. A count is at least 1 exactly when the node is an
   answer at all;
2. then the head's **acceptance instant**, descending. No column is named `accepted_at`: it is
   the head row's `node_revisions.created_at`, which `publishRevision` stamps with the clock value
   at which it accepted the revision (the same value it writes to `nodes.updated_at` when the head
   moves there). It is read raw as `timestamp[us]` microseconds and compared as a bigint. A
   revision that arrives by migration (#34) orders by whatever `created_at` the migration writes;
3. then **`node_id`** ascending, by UTF-16 code unit.

One hit per node makes this a total order; `rank` is the 1-based position in it. The wire shape is
unchanged: no new field, and neither key is on the wire. What changes is only the order, and so,
at a bounded `limit`, which hits come back.

**`limit` applies last.** Each candidate source is read ONCE for up to `FTS_CANDIDATE_CEILING`
(4096) chunks, every candidate is re-checked as section 13 says, the survivors are ordered, and
the answer is the first `limit` recall-eligible nodes of that order. Below the ceiling (3) a
bounded answer is therefore the head of the unbounded one, byte for byte. (The first cut of this
amendment stopped as soon as `limit` nodes survived a round of `limit × FTS_CANDIDATE_FACTOR`
chunks in BM25 order; section 2 lists what that still leaked.)

- **All three paths answer in this order**: the index path (`match: "ngram"`), the short-query
  scan (`"short_query"`) and the no-index scan (`"index_unavailable"`). A seam-scan hit
  (section 13's 3-4 code point case) is ordered together with the index hits of the same
  answer, not placed after them. Its per-hit `match: "substring_scan"` is unchanged.
- **The seam scan runs on every 3-4 code point index query**, not only when the index answered
  fewer than `limit` nodes: a node only the seam scan can see may be R22's first, and a bounded
  answer that skipped the scan would drop it. A node the index found is still reported as
  `"ngram"`, with its index chunks as `chunk_ids`; the seam scan adds only the nodes the index
  could not see.
- **Eligibility is asked down the order.** #29's check (`recallEligibleNodeIds`) costs several
  reads per node, so `currentEligibleChunks` asks it only for matching nodes in R22 order, until
  `limit` pass. That keeps the same nodes as judging every one, and bounds this cost by `limit`
  instead of by the candidate count.
- **BM25's `_score` is never read.** Keyword candidates carry no source rank
  (`rankedChunk(row, null)`); `hits[].match` comes from which source read the node's chunks.
- **v3 adapter** (section 15): `oracle_search` / `oracle_ask` call the kernel once per v3 word
  (`search.keywordTerms.ts`), so each word's occurrences are counted by the kernel under R14's
  rule, one word per call. `mergeKeyword` consumes only positions (more matched words first, then
  best position), and the v3 `score` stays `1/(1+position)` in the final order. None of that
  code changed. The kernel positions it reads are now workspace-local.
- **Cost, measured.** An A/B of the service in one process, against the same fresh dataset: this
  fix against the first R22 cut (`1bfa4a2`), median of 15 calls each (7 for the last row),
  Apple M5 Max, with other agents' test suites running on the same machine. Treat the numbers as
  relative, not as a benchmark.

  | ALPHA corpus, query | limit | first cut (ms) | this fix (ms) |
  |---|---|---|---|
  | 5 matching nodes, `kettle` | 10 | 20.2 | 19.8 |
  | 5 matching nodes, `kettle` | 1 | 14.0 | 6.0 |
  | 300 matching nodes, `kettle` | 10 | 833.0 | 268.8 |
  | 300 matching nodes, `kettle` | 50 | 4408.6 | 1134.6 |
  | 300 matching nodes, `ket` (seam scan too) | 10 | 981.3 | 350.4 |
  | 3565 candidate chunks of one edited non-matching node, 1 match | 10 | 134.7 | 36.7 |

  The fix reads more candidate rows. With 300 matches at limit 10 it reads 300 rows where the
  first cut read 40. Even so it is faster in every row, because the first cut asked eligibility
  of every node in each round (up to 40 at limit 10, up to 200 at limit 50), and this fix asks
  it of about `limit` nodes. In rows 2 to 5 the two cuts also returned different answers: those
  are the leaks section 2 describes. Rows 1 and 6 agreed.
  The order keys themselves cost one more column on the head read the substring re-check already
  makes (`created_at`), plus one count over text already in memory. Semantic search is untouched.
- **Ranking quality, the trade R22 names**: the count is not normalized for length, so a long
  node that repeats the query ranks above a short, focused one; BM25 would have reversed that.
  R22's "reverse by" line (back to BM25 order) is the way back, at the cost of the leak below.
  No retrieval-quality number exists either way (#7).

### 2 · What it closes, measured

The R21 fix round's own repro (17.1.1) is now inverted, not deleted. Workspace ALPHA holds A1
(query plus `abc`×40) and A2 (query plus `def`×40), and BETA indexes 12 nodes of `abc`×60, which
depresses `abc`'s corpus-wide IDF. Under R21 ALPHA's order flipped from A1,A2 to A2,A1, so at
`limit: 1` the answer changed from A1 to A2. Under R22, ALPHA's answers are byte-identical before
and after BETA's writes: the multi-hit query (A1,A2; one occurrence each, one writer instant, so
node id), the same query at `limit: 1` (A1), and a single-hit query built only from the trigrams
BETA depresses (`abcabcabc` → A1).

The R22 fix round's verifier then refuted this amendment's first cut. That cut stopped once
`limit` nodes survived a round of `limit × 4` candidate chunks, taken in BM25 order. A candidate
is any chunk sharing a trigram with the query, stale revisions included, so BM25 still chose which
matches came back, even with far fewer matches than the round. Three corpora showed it. Each was
red against the first cut and is green now (`search-chunk-retrieval-overfetch-bound.test.ts`):

- **ties.** X plus 7 F nodes with byte-identical bodies, at `limit: 1`: 8 candidates against a
  round of 4. BM25 ties the F chunks, and which 4 LanceDB returned varied between identical fresh
  datasets. 3 of 7 runs answered F2 or F3 instead of F1, with no BETA write involved.
- **stale.** 2 matches (X, and M edited 3 times) make 5 candidate chunks. At `limit: 1` the
  answer was M before BETA-only writes and X after.
- **default.** 11 matches (10 nodes edited 3 times each, plus X) make 41 candidate chunks. At the
  DEFAULT `limit` of 10 (a round of 40), X, which is R22's first, was missing before BETA wrote
  and present after, and M00 dropped out.

Under this fix every one of those answers is byte-identical before and after BETA's writes, and
equal to the head of the `limit: 50` answer. The `ties` answer was X in 14 of 14 runs.
`search-chunk-retrieval.test.ts` again pins "`limit: 1` is the unbounded answer's first hit".
The first cut had replaced that with the measured violation.

### 3 · The residual, and its measured bound

R22 still lets BM25 choose which candidate chunks are read. That choice is corpus-wide, so the
isolation holds only while every candidate is read.

- **The read.** The index path reads candidate chunks in one query of up to
  `FTS_CANDIDATE_CEILING = 4096` rows (`fts/fts.constants.ts`), in BM25 order, prefiltered to the
  workspace. The seam scan and the no-index or short-query scan each read up to 4096 rows in
  node-id order. `FTS_CANDIDATE_FACTOR` and `fts/fts.overfetch.ts` no longer apply to keyword
  search; legacy substring search and semantic search keep them.
- **A candidate chunk** is any chunk of the workspace whose text shares at least one trigram with
  the query (the `MatchQuery` terms are OR-ed). That includes chunks of stale revisions, of
  retired or superseded nodes, and of every embedding profile. It is a count of chunks, not of
  matches.
- **The bound.** If the workspace holds fewer than 4096 candidate chunks for the query, the read
  comes back short, every candidate is read, and BM25's order among them decides nothing. The
  answer is then a function of that workspace's own rows. No other workspace's write can change
  it, in order or in bytes, and a bounded answer is the head of the unbounded one. A read that
  comes back with exactly 4096 rows cannot tell whether more existed, so treat "4096 or more" as
  past the bound.
- **Chunks, not matches: where this falls short of the ruling's wording.** R22 accepts a
  residual "when the workspace has more matches than the candidate overfetch". This bound
  counts candidate chunks, and a workspace can pass it with few matches. A query whose trigrams
  are common, such as `the`, makes most of a large workspace's chunks candidates. Counting
  matches instead would need the head and substring check inside the index read: a
  per-workspace index, or a current-head flag on chunk rows. Neither exists. The ceiling is the
  tightest bound this storage allows.
- **Past the bound, measured at the real ceiling** (`search-chunk-retrieval-candidate-ceiling.test.ts`,
  query `abcxyz`, `limit: 50`):
  - ALPHA holds X (the query once, then `xyz`×240), its only match. It also holds BIG, one node
    edited into 5 revisions of about 891 chunks each. BIG's head never holds the query, but every
    chunk of it holds all four of its trigrams.
  - Up to 4 BIG revisions (at most 3565 candidate chunks), the read comes back short and the
    answer is X.
  - The 5th revision makes 4456 candidates. The read comes back full, at 4096 rows, and X, still
    BM25's best of ALPHA's own rows, is answered.
  - BETA then indexes two nodes of `xyz` repeated. They are never ALPHA candidates, but the
    writer's refresh rebuilds the shared index with them, and `xyz`'s corpus-wide IDF collapses.
    ALPHA's next answer is `[]`: BM25 filled the read with BIG chunks, and ALPHA's only match was
    not read. Nothing in ALPHA changed. This is the residual R22 names. The same `[X]` → `[]`
    flip showed in 3 of 3 scratch runs and 6 of 6 runs of the test.
  - Index state is part of the same residual. In scratch runs, BETA rows that the refresh policy
    had not yet indexed (`fts.refreshStaleFtsIndexOn` rebuilds once unindexed rows reach indexed
    ones) did not move ALPHA's answer, and the same rows did once a rebuild covered them.
- **Past the bound, identical datasets can answer differently.** BM25 ties chunks with equal
  text, and which of the tied chunks fill a limited read is not deterministic. The first cut hit
  this far below 4096: its `ties` corpus answered F1, F2 or F3 across identical fresh datasets.
  The same can happen past the ceiling. Below it, every tied chunk is read, and the answer is the
  same on every run.
- **The scans** read candidates in node-id order within the workspace, so which candidates they
  read is always workspace-local, including past the ceiling, where they read the first 4096 by
  node id. Below the bound, the scan and the index return the identical hits in the identical
  order (everything but each hit's `match`). Past it, each path answers the best of what its own
  read held, so the two can differ.
- **Unchanged:** `match` and `scan_reason` still show whether the governed index exists. That is
  section 14's one-bit disclosure: any workspace's first `indexRevisionChunks` builds the shared
  index. R22 makes both paths answer in the same order; it does not hide which path answered.

**Reverse or close by**: a per-workspace FTS index, or per-workspace BM25 statistics (R21's and
R22's own line), which closes the residual fully. Raising `FTS_CANDIDATE_CEILING` moves the bound
linearly. The added cost is one candidate row and its head read per candidate; eligibility stays
bounded by `limit`. The ceiling is shared with legacy substring search and semantic search, so
it is unchanged here.

### Proof

Every test was run red against the unfixed code first, then green after the fix. Fresh
`mktemp -d` datasets, real writer gate, no model.

- `app/server/test/search-chunk-retrieval-order-key.test.ts` (new, pure): `countFolded`, including
  non-overlap, Thai inside a word and final sigma, agreeing with `containsFolded` over a sample
  grid; `keywordHitOrder`'s three keys, microsecond-exact; and a total order, where every
  permutation sorts to one sequence. Red: the helpers did not exist.
- `app/server/test/search-chunk-retrieval-order.test.ts` (new): a corpus where R22's order is
  neither BM25's nor node id's.
  - MANY: 3 folded occurrences, the oldest head, the largest id. It comes first.
  - NEWER: 1 occurrence, accepted later. It comes before two tied nodes.
  - TIE_A and TIE_B: identical text at one instant, ordered by node id.
  - Then new heads move nodes: 5 occurrences, and a later acceptance. The stale chunks count for
    nothing.
  - The same order holds on the index path, the short-query scan and the no-index scan. The
    scan's hits equal the index path's.
  - Fix round: a seam-only node accepted last is R22's first for `wxyz`. It stays first at
    `limit: 1`, even though the index already found a hit. Red: the first cut answered the index
    node. Eligibility is judged only down the order: at `limit: 1` it is asked of the refused
    three-occurrence node and then one more, not all four. Red: all four.
  - Red: BM25 gave `[MANY, TIE_A, TIE_B, NEWER]`; the scans gave node-id order.
- `app/server/test/search-chunk-retrieval-score-isolation.test.ts`: the second `describe` is
  inverted, as section 2 describes. Every other assertion is kept: the set never crosses
  workspaces, there is no `score`, and ranks are `[1, 2]`. Red: `after` had A2 first.
- `app/server/test/search-chunk-retrieval-overfetch-bound.test.ts` (rewritten in the fix round):
  the `ties`, `stale` and `default` corpora of section 2, each on its own fresh dataset. Each
  answer must be byte-identical before and after BETA-only writes, and each bounded answer must
  equal the head of the `limit: 50` answer. The spy must show one index read, asked for 4096 and
  returned short, and eligibility judged only for the nodes kept. The first version of this file
  pinned the first cut's leak on BM25-tied bodies and failed 3 of 7 runs. Red: the bounded
  answers were F01 (`ties`), M (`stale`) and ten nodes without X (`default`), each before any
  BETA write. Green: 14 of 14 runs.
- `app/server/test/search-chunk-retrieval-candidate-ceiling.test.ts` (new): the measurement of 3
  above. Red: the first cut made four doubling reads, not one.
- `app/server/test/search-chunk-retrieval.test.ts`: its pin of BM25 order (`[thai, pending]`) is
  now R22's `[pending, thai]`. The first cut had replaced "`limit: 1` is the unbounded answer's
  first hit" with the measured violation; that guarantee is restored, byte for byte. Red: the
  first cut answered thai. Also new: a rebuilt index returns the identical answer, and both scans
  equal the index path's hits.
- `test/fixtures/search-chunk-v1/core/gated-retrieval.ts`: an `@file` payload (argv is capped
  near 1 MB). Its `spyKeyword` also reports each candidate read (source, rows asked, rows
  returned) and the node ids eligibility judged, in order.
- The v3 adapter's suites (`mcp-v3-*.test.ts`, the acceptance harness included) pass unchanged.

## 21. Amendment 2026-09-27 (post-merge #30 coverage)

Source: [`docs/overnight/DECISIONS.md`](../../../docs/overnight/DECISIONS.md) **R22** ("Known
residual: when the workspace has more matches than the candidate overfetch, *which* candidates
enter the set can still depend on global statistics. It is documented with the measured bound"),
with R21 (no raw score) and R7. The acceptance audit of `Soul-Brews-Studio/arra-oracle-v4#30`
found one gap: section 20.3 documented the bound, but no answer said when it was reached, so a
caller could not tell a complete answer from a saturated one. Sections above are left as written;
this adds three fields and changes nothing else.

### 1 · The fields

`searchKnowledgeKeyword` and `searchKnowledgeSemantic` both answer three more closed fields, on
HTTP, MCP and CLI alike (all three pass the kernel's value through the one registry entry):

```
coverage          "full" | "partial"
coverage_reason   "candidate_ceiling" | null      (null exactly when coverage is "full")
candidate_ceiling 4096                            (FTS_CANDIDATE_CEILING, the bound itself)
```

- **Keyword**: `"partial"` when ANY candidate read of the request -- the index read, the seam
  scan, or the short-query / no-index scan -- came back holding `candidate_ceiling` rows, counted
  as read, before `chunkMayHoldQuery` drops any. Section 20.3 already says a full read cannot tell
  whether more existed, so "4096 or more" counts as past the bound. Past it the answer may be
  missing matches, and, on the index path, which candidates were read may depend on the index
  every workspace shares (the R22 residual). `"full"` means every read came back short: every
  candidate was read, and section 20.3's isolation holds for this answer.
- **Semantic**: `"partial"` when the shared overfetch loop (`fts.overfetchCoverage.ts`, which
  `overfetch` now delegates to, unchanged for legacy substring search) stopped at the ceiling:
  its last round asked for and got `candidate_ceiling` nearest chunks and fewer than `limit` nodes
  survived (stale revisions, retired nodes and several chunks of one node all take read slots).
  A farther match may exist unread. An answer that reached `limit`, or whose source ran dry, is
  `"full"`. Semantic search has no cross-workspace leak to disclose (section 17); this is only
  completeness.
- **What it is not.** `limit` is paging, not coverage: `"full"` with `hits.length == limit` is a
  complete first page. It counts chunks, not matches (section 20.3), so a common-trigram query can
  be `"partial"` with few answers. A semantic distance tie straddling the last read's boundary is
  not flagged.

### 2 · Why it cannot leak another workspace

Every read behind the flag is PREFILTERED to the requesting workspace (`fullTextSearchChunks`,
`vectorSearchChunks` and `orderedProjection` all take the workspace scope as their predicate;
measured in section 13), so whether a read fills the ceiling is a function of that workspace's
own rows. BM25 may choose WHICH of them fill it; it cannot change HOW MANY there are. The field
carries no count and no score: one bit, a closed reason, and a server constant. The bit does say
that this workspace holds at least `candidate_ceiling` candidate chunks for the query, stale
revisions and retired nodes included -- about the caller's own workspace, which it may already
read.

### 3 · Callers

- The v2 UI (`KnowledgeSearchResults`) shows "Results may be incomplete" on a `"partial"` answer,
  for hits and for an empty answer, in both modes.
- The v3 adapter (`oracle_search`, `oracle_ask`) is unchanged: it reads `hits` and ignores the new
  fields. Its own `saturated` warning still speaks only of its 50-hit window; folding the kernel's
  `coverage` into it is not done here.
- A caller that pins the exact key set of an answer must add the three keys.

**Reverse by**: dropping the three fields (no stored state depends on them). A per-workspace FTS
index (R22's own line) closes the keyword residual; the fields then still report the read bound.

### Proof

Fresh `mktemp -d` datasets, real writer gate, stub query vectors, no model.

- `app/server/test/search-chunk-retrieval-coverage.test.ts` (new): the ceiling is injected through
  the harness op `searchAtCeiling` (a trailing `ceiling` argument only tests pass; production
  calls the services with three and four arguments and gets 4096). Keyword: 3 matches read under a
  ceiling of 4 are `"full"` while BETA, holding 6 candidates, is `"partial"` under the same ceiling
  and never moves ALPHA's; a 4th candidate that is not a match makes ALPHA `"partial"` at any
  `limit`; 5 makes it `"full"` again; the short-query scan reports its own read, and at a ceiling
  of 2 answers the first 2 by node id. Semantic: a stale nearest chunk plus the head fill a ceiling
  of 2 with one node of the two asked for (`"partial"`, `[S]`); a ceiling of 3 is `"full"`,
  `[S, T]`; a source that runs dry below the ceiling is `"full"`. The default reader path reports
  `"full"` and 4096 on both methods, and each answer's key set is closed. Red before the fix: 5 of
  7 failed, every field `undefined`. Mutants, each red: `>` for `>=`; keyword never saturated; the
  scan ignoring the injected ceiling; semantic never saturated, ignoring `limit`, ignoring a dry
  source.
- `app/server/test/search-chunk-retrieval-live.test.ts`: the fields on the HTTP body, and MCP's
  value still equals it byte for byte. `app/server/test/cli-search.test.ts`: the CLI prints them
  verbatim.
- `app/ui/v2/src/components/KnowledgeSearchResults.coverage.test.ts` (new, render): red 3 of 4
  against the previous component.

## 22. Amendment 2026-09-27 (post-merge R18 (v3 parity) + R21/R22 + #30 coverage amendment)

Source: `docs/overnight/DECISIONS.md` R21 (no raw score), R22 (keyword order and candidate
selection are workspace-local, "known residual" documented with the measured bound), and issue
`Soul-Brews-Studio/arra-oracle-v4#30`. Section 21 above shipped the three fields and said plainly,
in its own "3 · Callers": *"The v3 adapter (`oracle_search`, `oracle_ask`) is unchanged: it reads
`hits` and ignores the new fields... folding the kernel's `coverage` into it is not done here."*
The acceptance verifier of the v3-coverage slice (`.tmp/ac-search-accept-nonblocking.txt` finding
1) flagged that gap as the live bug it is: `search.retrieve.ts` computed its OWN `saturated` only
from v3's 50-hit window (`answer.hits.length >= SEARCH_WINDOW`), so a kernel `coverage:"partial"`
answer with FAR FEWER than 50 merged hits -- the exact R22 residual measured for real in
`search-chunk-retrieval-candidate-ceiling.test.ts` -- reached `oracle_search`/`oracle_ask` (46% of
measured real v3 traffic) looking complete. This section corrects that statement; sections above
are left as written otherwise.

### 1 · The fix

- `search.retrieve.ts`'s `Retrieved` type gained three fields -- `coverage`, `coverageReason`,
  `candidateCeiling` -- carried verbatim from the kernel's `searchKnowledgeKeyword` /
  `searchKnowledgeSemantic` answer (per fts term, OR'd: `coverage:"partial"` the moment ANY term's
  own candidate read saturated). This is independent of, and in addition to, the adapter's own
  `saturated` (the 50-hit v3 window): a kernel candidate read can saturate while the merged answer
  is two hits, and a merged answer of exactly 50 hits can still have every candidate read short.
- **Where it surfaces, and why there (V3-PARITY.md §2.5 "Allowed additions: `compat_warnings` and
  a `v4` object")**: as a `compat_warnings` entry, `{code:"partial", field:"metadata.coverage" |
  "search.coverage", detail}`, naming `candidate_ceiling` and the reason. `"partial"` was already
  in V3-PARITY's closed warning-code set (§2.5) and already the code `oracle_search`'s own 50-hit
  `saturated` warning uses (`metadata.total`) -- the adapter's existing honesty mechanism, the same
  one `oracle_stats.ts` and `oracle_concepts.ts` already use to surface a `listTermUsage`
  `coverage:"partial"`. A new top-level or `metadata`-key addition was considered and rejected: the
  three raw kernel field names are LanceDB/candidate-read vocabulary a v3 client was never taught,
  where `compat_warnings` is exactly v3-compat's own contract for "something changed, here is
  what and why" -- and it is additive, so the pinned `test/fixtures/v3-compat-v1/shapes/oracle_search.json`
  shape needs no change (`matchesShape` already allows extra keys, `test/helpers/v3-compat-shapes.ts:231`).
- `oracle_ask` gained the same warning (`field:"search.coverage"`); the original finding named both
  tools, and `oracle_ask` shares the same `recall()` → `retrieve()` path and had no coverage warning
  of any kind before this section.
- `oracle_search_chain` is unchanged: it calls `searchKnowledgeSemantic` directly, never through
  `retrieve()`/`recall()`, and was outside the cited finding's scope.

### 2 · Test strength (verifier finding 2)

`search-chunk-retrieval-candidate-ceiling.test.ts` -- the real 4096 bound, not the injected-ceiling
harness section 21's own proof used -- now also asserts `coverage`/`coverage_reason`/
`candidate_ceiling` on `big_1..4` (`"full"`), and on `big_5` and `after_beta` (`"partial"`,
`"candidate_ceiling"`, `4096`): the exact R22 residual (BETA-only writes moving ALPHA's answer)
now visibly says `"partial"` even where the merged answer itself still looks plausible.

### 3 · The CLI (verifier finding 3), honestly

`cli-search.test.ts`'s keyword test stubs the HTTP layer (`Bun.serve` echoing a fixed `response`),
so it always passed with the fix reverted -- it proves argument marshaling and verbatim printing,
never that a real kernel computed the fields. That has not changed: no test in this repo boots a
real listening server and a real `bun app/cli.ts search --mode keyword` subprocess together (the
pattern `fixtures/transport-v1/live-server/child.ts` uses for read-cursor/audit-parity has no
publish/index/embed step, and `fixtures/transport-v1/search/child.ts`, which does, calls
`app.handle()` in-process, never a CLI subprocess). The live probe's own CLI coverage
(`live-probe/payloads.py` `CLI['search']`) runs only the LEGACY bare `search --query`, never
`--mode keyword` -- so, contrary to this slice's non-blocking finding 3's aside, the `--issues`
live probe does **not** currently exercise the CLI's knowledge-tier search at all. The real
kernel-side proof (§21's own proof list, and section 2 above) covers HTTP and MCP, both
transports the live probe DOES drive live. A real CLI-subprocess round trip for `search --mode
keyword` remains a disclosed gap, not a silent one.

**Reverse by**: dropping the two `compat_warnings.push` call sites in `oracle_search.ts` and
`oracle_ask.ts` and the three `Retrieved` fields in `search.retrieve.ts`; nothing else depends on
them, and section 21's fields keep flowing to every other caller unchanged.

## 23. Amendment 2026-09-27 (fix-round 2: correcting two of §22's own citations)

Source: an independent re-verification of the v3-coverage slice (`docs/overnight/DECISIONS.md`
R21/R22, issue `Soul-Brews-Studio/arra-oracle-v4#30`), refuting a claim §22.3 made about evidence
-- not about the code fix itself, which the same verifier confirmed is correct and unchanged.
Per §18's own precedent ("frozen contracts are not rewritten... this amendment is the
correction"), §22's paragraphs are left exactly as written; this section corrects them.

### 1 · §22.3's live-probe claim was false

§22.3 said: *"the `--issues` live probe does **not** currently exercise the CLI's knowledge-tier
search at all,"* reasoning only from `live-probe/payloads.py`'s `CLI['search']` fixture (the
legacy bare `search --query` alias). That fixture is real, but it is not the only CLI path the
probe drives. `live-probe/issue_search.py` loops `for t in ['HTTP','MCP','CLI']:` over
`searchKnowledgeKeyword` and `searchKnowledgeSemantic` (its baseline positive controls and its
cross-workspace / retired-node / rank checks all run three ways). `live-probe/probe.py`'s
`call()`, for `transport=='CLI'`, does not touch the legacy alias at all -- it runs a REAL
subprocess, `bun app/cli.ts kb <method> --bank <bank> --json <payload>`, against the real running
server. Running `live-probe/run.sh <checkout> <label> --issues` and reading `out/<label>.json`
shows CLI-transport records for both methods carrying `coverage`/`coverage_reason`/
`candidate_ceiling` on the body, e.g.
`{"match":"ngram","scan_reason":null,"coverage":"full","coverage_reason":null,
"candidate_ceiling":4096,...}` for keyword, and the equivalent three fields for semantic.

The corrected claim: the `--issues` probe DOES exercise `kb searchKnowledgeKeyword` and
`kb searchKnowledgeSemantic` live, over a real CLI subprocess against a real server, and the
three coverage fields land on those CLI answers today. The gap §22.3 was reaching for is real but
narrower than it said: no test or probe in this repo drives the LEGACY-ALIAS shape,
`bun app/cli.ts search --mode keyword`, against a real listening server --
`cli-search.test.ts`'s `--mode keyword` test stubs the HTTP layer (wire pass-through only, as its
own comment says), and no live-probe payload calls `search --mode keyword` by that name. The same
correction applies to this slice's own deviations-from-ruling text, which repeated §22.3's claim
as something it had verified; it had not run `issue_search.py` or `--issues`.

### 2 · §22's own citation was not a repo path

§22's opening paragraph cites `.tmp/ac-search-accept-nonblocking.txt` as evidence from "the
acceptance verifier of the v3-coverage slice." That file is untracked and lives under a
different worktree (`arra-oracle-v4-overnight-26sep-sat2026`) -- it holds the ac-search slice's
own verifier notes, not this slice's, and it is not a path this repo's git tracks. The finding it
names is still described correctly; only its provenance is corrected here.

**Reverse by**: nothing to reverse -- this section changes no code and no test, only the
provenance of two citations in §22's prose. §22 itself, and the fix it documents, stand as
shipped.

## 24. Amendment 2026-09-27 (chain-coverage slice: the three non-blocking findings the v3-coverage
verifier left open)

Source: `docs/overnight/DECISIONS.md` R21/R22, issue `Soul-Brews-Studio/arra-oracle-v4#31`,
and `.tmp/v3-coverage-w10-accept-nonblocking.txt` (untracked, a different worktree; cited the
same way §23.2 discloses its own out-of-repo citations). §22 shipped the three #30 coverage
fields for `oracle_search`/`oracle_ask` and said plainly, in its own "1 · The fix": *"`oracle_search_chain`
is unchanged: it calls `searchKnowledgeSemantic` directly, never through `retrieve()`/`recall()`,
and was outside the cited finding's scope."* That gap, and two test-strength gaps beside it, are
closed here.

### 1 · `oracle_search_chain` now carries coverage too, AGGREGATED across hops

`oracle_search_chain.ts:75` read `searchKnowledgeSemantic`'s per-hop answer as only `{ hits }`
and dropped `coverage`/`coverage_reason`/`candidate_ceiling` on every hop -- the same shape of
gap §22 fixed for `retrieve()`, in the one v3 recall tool that does not go through it.

- **Choice: aggregated, not per-hop.** `oracle_search_chain` tracks one running bit across every
  hop's own `searchKnowledgeSemantic` call: `"partial"` the moment ANY hop's candidate read
  saturated, exposed once as a `compat_warnings` entry (`{code:"partial", field:"hops.coverage"}`)
  after the loop -- the same OR shape `retrieve()` already uses to fold several fts terms into one
  `coverage` bit (§22.1). A per-hop field on the `Hop` record was considered and rejected: `Hop` is
  a small, already-pinned public shape (`mcp-v3-search.test.ts`'s `chain` test asserts it with
  `toMatchObject`), and `compat_warnings` is already this adapter's one channel for "the kernel
  measured something that changed the answer's completeness" -- the same reasoning §22.1 gives for
  putting `oracle_search`'s signal there instead of a new top-level key. The aggregated bit still
  answers the question v3 clients actually ask ("can I trust this chain completely?"); a caller
  that needs to know WHICH hop saturated does not exist among v3's own callers today, and can be
  added additively later without breaking this shape.
- The type `search.retrieve.ts` already declared locally for A1 (no adapter import from
  `publication/*`) is now `export`ed as `KernelCoverage` so `oracle_search_chain.ts` shares it
  rather than retyping the same three fields a third time.

### 2 · The negative case is now pinned for all three v3 recall tools

Nothing tested that a `"full"` answer produces NO coverage warning. The verifier proved this live:
mutating `search.retrieve.ts`'s `const partial = answers.some(...)` to `const partial = true` left
`bun run test:mcp`'s 307 tests green. Fixed by adding, for `oracle_search`, `oracle_ask` and
`oracle_search_chain` alike:
  - a real-wire negative pin in `mcp-v3-search.test.ts` (the gated dataset never reaches the real
    4096 ceiling, so `s_apfs`, `ask_false` and `chain` must each carry NO `partial` warning on
    their respective coverage field); and
  - a stub-`kb` negative pin in `mcp-v3-search-wiring.test.ts`, plus a direct `retrieve()` pin,
    each constructing a `coverage:"full"` kernel answer and asserting no warning surfaces.

### 3 · A compile-time tie between the adapter's local type and the kernel's own

Nothing tied `search.retrieve.ts`'s local `KernelCoverage` to
`publication/search-chunk.coverageSignal.ts`'s `CoverageSignal` at compile time: every v3 test
stubs `kb` with hand-written field names, so a kernel rename would leave every stub matching
itself and every warning silently stop firing with the whole suite green. A1 (V3-PARITY.md §3,
"no import from `publication/*`") binds the ADAPTER's own source, not a test file, so
`search-chunk-coverage-tie.test.ts` (new) imports both types directly: a compile-time mutual
`AssertAssignable` check (fails `bun run typecheck` if either type stops matching the other), plus
a runtime assertion that a real `coverageSignal()` call has exactly the three keys
`KernelCoverage` expects, at both its `"full"` and `"partial"` shapes.

### Proof

`search.retrieve.ts` and `search-chunk-coverage-tie.test.ts` need no store at all (pure types and
a pure function); `oracle_search_chain.ts`'s new aggregation is proven against a stub `kb`
(`mcp-v3-search-wiring.test.ts`) and against the real gate, real dataset, real embedder stub
(`mcp-v3-search.test.ts`'s existing `chain` step, which already ran hops with distinct real
kernel answers). `bun run test:mcp` (313 pass / 0 fail, including `mcp-v3-acceptance.test.ts`'s
37/37 steps), `bun run test:search-chunk` (157 pass / 0 fail across 22 files, including the new
tie test) and `bun run typecheck` are all green after this section; the Python architecture guard
(`app/migrate-py` `unittest discover`) is unaffected -- no new TS source file under
`app/server/src` imports the publication kernel (the tie test lives under `app/server/test`,
outside `test_no_active_server_source_imports_the_publication_kernel`'s `TS_ROOT` scan).

**Reverse by**: dropping the `hops.coverage` push and the `KernelCoverage` export in
`oracle_search_chain.ts`/`search.retrieve.ts` (nothing else depends on them), and deleting
`search-chunk-coverage-tie.test.ts`; the negative-pin assertions are additive lines inside
existing tests and can be deleted individually without affecting anything else they assert.

## 25. Amendment 2026-09-26 (post-merge PROOF.md rule: every number measured, the command beside it; doc-contradicts-code is a defect)

Source: `docs/overnight/DECISIONS.md` (the PROOF.md rule), issue #22, and the proof sweep
(`docs/overnight/PROOF-SWEEP.md`). Written 2026-09-27 on `594df54`.

**Change.** §12's **Why** (`search-chunk-v1.md:278`, the paragraph that begins "**Why.** DESIGN.md:1119")
quotes DESIGN.md: "stale vectors never present superseded content as current truth." That line
is not `:1119`. It was `:1121` in the commit that wrote the citation (`c3ab9a8`), and on `594df54`
it is `DESIGN.md:1125`, because lines were added above it later that day. The quoted text is
right; only the line number is wrong. The original paragraph is left as written, because frozen
contracts are not rewritten; this amendment is the correction.

**Why.** A `file:line` that no longer holds what the contract says it holds is a
doc-contradicts-code defect under the PROOF.md rule.

**Command.** `rg -n 'stale vectors never present' DESIGN.md` prints `1125:`, and
`git show c3ab9a8:DESIGN.md | rg -n 'stale vectors never present'` prints `1121:`.
`python3 docs/overnight/proof-sweep-check.py` re-checks this row with the others.

## 26. Amendment 2026-09-27 (ac1-hardening slice: two defects in §24 itself)

Source: `docs/overnight/DECISIONS.md` R21/R22, issue `Soul-Brews-Studio/arra-oracle-v4#31`, and
`.tmp/chain-coverage-w11-accept-nonblocking.txt` (untracked, a different worktree; cited the same
way §23 discloses its own out-of-repo citations). §24's own code fix is unchanged and correct;
per §18/§23's own precedent, frozen contract text is not rewritten in place, so this section
corrects §24 rather than editing it.

### 1 · §24's own heading was split across two markdown lines

The heading `## 24. Amendment 2026-09-27 (chain-coverage slice: the three non-blocking findings
the v3-coverage` broke onto a second line, `verifier left open)`, with no `#` prefix. GitHub and
every standard renderer treat only the first line as the heading; the second line, including the
closing paren, renders as an ordinary body paragraph directly under an unclosed-looking title.
Per §18/§23's own append-only precedent, §24's actual heading text is left as shipped (still split
in the file above); documented here only so a reader knows what it should have read as one
line: `## 24. Amendment 2026-09-27 (chain-coverage slice: the three non-blocking findings the
v3-coverage verifier left open)`.

### 2 · §24's "Proof" section overclaimed the real-wire evidence for the positive case

§24's "Proof" paragraph said `oracle_search_chain.ts`'s new aggregation is proven "against a stub
`kb`... and against the real gate, real dataset, real embedder stub (`mcp-v3-search.test.ts`'s
existing `chain` step...)," without distinguishing which case each proof covers. The real-wire
`chain` step in `mcp-v3-search.test.ts` runs against the gated dataset's fixture data, which never
reaches the real 4096-row candidate ceiling; that step therefore proves only the NEGATIVE case --
a full-coverage chain carries no `partial` warning on `hops.coverage`. It does not drive any hop
to saturation, so it is not evidence for the POSITIVE case (a saturating hop's `partial` warning
surfacing, aggregated OR-across-hops). That positive case is proven only against the stub `kb` in
`mcp-v3-search-wiring.test.ts` ("one hop's own candidate read saturating..." and "hop order does
not matter..."). The gap this leaves -- no real-4096-row (unmocked ceiling) chain test exists --
is disclosed as open_risk 3 in the chain-coverage slice's own implementer report, as recorded by
the acceptance verifier's notes (`.tmp/chain-coverage-w11-accept-nonblocking.txt`, untracked, a
different worktree, cited the same way §23 discloses its own out-of-repo citations): "No
real-4096-row (unmocked ceiling) chain test exists. This is disclosed as open_risk 3..."; it is
not disclosed anywhere in §21, §22, or §24 §3 themselves -- §21 never mentions "chain," §22
mentions it once only to say `oracle_search_chain` is unchanged, and §24 §3 (the compile-time
`KernelCoverage`/`CoverageSignal` tie) carries no open-risk note. The corrected claim:
`search.retrieve.ts` and
`search-chunk-coverage-tie.test.ts` need no store at all; `oracle_search_chain.ts`'s new
aggregation, BOTH the positive and negative case, is proven against the stub `kb`
(`mcp-v3-search-wiring.test.ts`); against the real gate, real dataset, real embedder stub
(`mcp-v3-search.test.ts`'s `chain` step), only the negative case is proven.

**Reverse by**: nothing to reverse -- this section changes no code and no test, only the heading
markup and the provenance of one claim in §24's prose. §24 itself, and the fix it documents,
stand as shipped.

## Amendment 2026-09-26 (post-merge Nat style: one exported function per file, named after the file (ratchet: app/server/test/one-function-per-file.test.ts))

The path cited above, `auth/service.ts`, moved. The style-shrink slice
(`docs/overnight/DECISIONS.md`; ratchet `app/server/test/one-function-per-file.test.ts`
MISNAMED_ALLOWLIST) renamed it to `auth/service.createOperationService.ts` by `git mv`
(similarity 99%: one import line changed, `./loader` -> `./loader.loadPolicy`, for the
sibling rename in the same slice) -- `runMcp` (a method on the object the sole export
`createOperationService` returns, not itself an export) and every export are
byte-identical; only the filename and that one import path changed, to satisfy the
ratchet's "one exported function per file, named after the file" rule. This section is
not rewritten in place; read `auth/service.ts` above as `auth/service.createOperationService.ts`.
