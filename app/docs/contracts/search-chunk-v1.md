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

## 12. Amendment 2026-09-26 (overnight R7 (#30 part) + R8)

Slices A (embedding-profile registry), B (`reconcileSearchChunks` correctness +
`getSearchFreshness`) and C (`embedPendingChunks`, the embed worker), per
`docs/overnight/DECISIONS.md` R7 and R8. This corrects §1's and §9's "not-yet-implemented"
language about the embed step — a real, injectable embedder now exists and is wired in
`composition.ts` — and supersedes §6's description of `reconcileSearchChunks` with the
behaviour below; §6 is left unedited as a historical record of the pre-amendment sweep.

**A — the closed embedding-profile registry** (`search-chunk.profiles.ts`, new). Every
`embedding_profile` a request may write OR list is now checked against ONE active profile,
not accepted as free text: `activeEmbeddingProfile()` returns `{profile_id, provider: "ollama",
model: "all-minilm", dims: 384, normalization: "none", document_prefix: "", query_prefix: "",
input_rule: "chunker/v1:title\n\nbody"}`, and `profile_id` — the string stored as
`embedding_profile` — is `ollama/all-minilm@<digest12>/384/none`. A name outside the registry
is `invalid_value` at `/embedding_profile/name`, checked in BOTH `embeddingProfile()` (the
`indexRevisionChunks` request object) and `parseListChunks` (its bare string field), before
the frozen-384 `dims` check that already existed. R7's own text — "one table holds several
embedding profiles, as built" — is a statement about the physical schema, not this registry:
a row written under a retired or pre-registry profile id is never deleted and stays physically
present; only a REQUEST naming a non-active profile is refused (`search-chunk-service.test.ts`'s
F5 test proves this precisely, by planting such a row directly and confirming
`listSearchChunks` still excludes it).

The model digest is measured at real server startup (`composition.ts`'s
`runStartupIndexWork`, best-effort, never blocking) and recorded via
`configureActiveEmbeddingModelDigest`; absent a measurement (Ollama down, or in every test),
the id carries the literal segment `unmeasured` rather than a fabricated digest. **Measured
correction to the brief**: the brief said to read the digest from `POST /api/show` — measured
2026-09-26 on m5 against a real local Ollama serving `all-minilm`, that endpoint's response
has NO `digest` field at all (top-level keys: `license`, `modelfile`, `parameters`,
`template`, `details`, `model_info`, `capabilities`, `modified_at`). `GET /api/tags` does
carry one, per installed model, in `models[].digest` — measured-on-m5 that day:
`all-minilm`'s was `1b226e2802dbb772b5fc32a58f103ca1804ef7501331012de126ab22f67475ef`.
`fetchOllamaModelDigest` reads `/api/tags`, not `/api/show`, for exactly this reason.

**B — `reconcileSearchChunks` correctness.** Presence is now recomputed from the head
revision's own title/body (`chunkText`/`deriveChunkId`/`deriveContentHash`, the identical
derivation `indexRevisionChunks` uses) rather than trusted from row COUNT alone, and scoped to
`(revision_id, CHUNKER_VERSION, active profile)` — a revision indexed only under a non-active
profile now correctly counts as missing for the active one. The response gains `incomplete`
(a partial expected set; the revision still lands in `missing_revisions`), `hash_mismatch` (a
present row whose `content_hash` no longer matches the recomputed one), `ineligible` (a
retired-or-superseded node, `getRecallEligibility`'s own `supersede_log` check — excluded from
missing/incomplete/hash_mismatch/stale accounting entirely, since its content is not expected
to be currently indexed), `missing_source` (a chunk row belonging to no visited node, or whose
`revision_id` is not any visited node's accepted head — global, bounded by the node sweep) and
`pending`/`ready`/`failed` (global counts for the active profile, matching
`getSearchFreshness`'s own vector counts). The `stale` probe — chunk rows surviving under a
node for a revision that is no longer its accepted head — now runs UNCONDITIONALLY for every
visited, eligible node: the earlier version's `continue` on a missing head skipped it exactly
when a superseding publish made the head itself unindexed (measured, analysis-30's op8),
under-counting `stale` in precisely that case. `missing`/`missing_revisions`/`stale`/`visited`/
`exhausted` keep their existing meaning and shape.

**B — `getSearchFreshness`** (new, `content:read`). Three stages, each answered from a
different measurement, with unknown kept distinct from a real zero: `content.nodes`/
`content.revisions` (plain counts, always knowable, so 0 is a real zero); `text_index.
indexed_rows`/`unindexed_rows` (from `DatasetAdapter.textIndexStats`, `null` when no lexical
index has been built yet on `search_chunks_v1.text` — this slice does not build that index,
so "not yet built" reads as unknown, never as zero); `vectors.pending`/`ready`/`failed` (global
counts for the active profile) plus `vectors.last_attempt_at` (the latest attempt across those
rows, `null` when none has ever happened).

**C — `embedPendingChunks`** (new, `content:write`, exposed per R8 so an external
backfill worker reaches it over HTTP, MCP and CLI `kb` identically). Reads `pending` rows, and
`failed` rows under `MAX_EMBED_ATTEMPTS` (5, matching `db.ts`'s legacy `MAX_SYNC_ATTEMPTS`),
for the active profile; tries content-hash reuse first (copying an existing `ready` row's
vector for the same workspace/chunker/active-profile/`content_hash`, costing zero embedder
calls); calls the injected embedder for the rest, OUTSIDE `core.serial` and bounded by
`Promise.race` against a timeout (`ARRA_EMBED_TIMEOUT_MS`, default 30s) that fires regardless
of whether the embedder itself honors its `AbortSignal`; then writes every outcome back
through ONE `core.serial` turn, reusing `writeChunkEmbedding`'s own update-then-verify-readback
shape. Failure is a real, closed `error_code` (`embedder_unavailable` — no embedder
configured; `embedder_timeout`; `embedder_bad_response`), with `attempts` incremented and
`status: "failed"` — `"failed"` and `error_code` are no longer merely reserved vocabulary
(§1), this is the writer that produces them. §9's claim "no code path in this kernel ever
populates `embedding` with a real vector" is superseded: `embedPendingChunks` is that path,
though `indexRevisionChunks` itself still never embeds (§1's "embedding is deliberately off
the authoritative write path" still holds). `composition.ts` wires the default embedder from
`embed.ts` (`embed()`, extended with an optional `AbortSignal` parameter, backward compatible
with its existing `db.ts` caller).

Proof: `app/server/test/search-chunk-reconcile.test.ts` (incomplete, hash_mismatch,
ineligible, missing_source, status counts, `getSearchFreshness`'s three stages) and
`app/server/test/search-chunk-embed-worker.test.ts` (the hang/timeout proof that a concurrent
`publishRevision` is never blocked, retry-to-convergence, content-hash reuse, no-embedder
failing closed, the `MAX_EMBED_ATTEMPTS` retry cap, and the full `publishRevision` →
`indexRevisionChunks` → `embedPendingChunks` → `getSearchFreshness` loop Nat asked for —
"index first, embed later, like backfill"). Every existing search-chunk test that indexed
under an arbitrary free-text profile name was updated to use the active profile id
(`activeEmbeddingProfileId()`); this is a mechanical fixture change, not a behavior change to
those tests' own subject matter.

Not in this amendment: retrieval (`searchChunks`, `searchChunkText`/`searchChunkVector`, the
FTS index on `search_chunks_v1.text`) — a concurrently-developed slice's file ownership, per
the overnight brief.
