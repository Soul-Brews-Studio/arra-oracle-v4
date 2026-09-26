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
18) and by `search-chunk-retrieval.test.ts`'s `writerContextMethods`.)*

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
its query. A request naming no profile reads the embedder's own; a request for a profile the
embedder does not serve is `invalid_value` at `/embedding_profile`, before any model call —
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

- No freshness report (unindexed-row count, pending/failed per profile).
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
  profile/model pairing are the seam a registry replaces.
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
