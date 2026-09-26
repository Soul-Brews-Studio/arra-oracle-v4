# Candidate target-v1 schema decisions

**2026-09-20 — revision 1, isolated #23 implementation contract.**

Owner: v4-codex (design and acceptance). Implementer: neo-claude. Independent critic approved this bounded slice with the retained-time clarification below. No claim of schema freeze, feature completion, or live migration follows from this document.

This is an explicit candidate refinement of [DESIGN.md](../../../DESIGN.md), particularly sections 6–8 and 11. The published discussion #36 remains the historical revision-2 snapshot; this addendum does not rewrite its historical evidence. Runtime remains the active15 memory spike until separately verified migration/cutover.

## 1. Registry and ownership

```text
ACTIVE / UNCHANGED                         ISOLATED CANDIDATE
models.TABLES: 15                          target_v1: 19
       |                                        |
       | live app/migrator                       +--> scratch Arrow/LanceDB fixtures
       |                                        +--> Bun schema/row verification
       +--------- NO automatic activation ------+

19 = 15 - memories - memory_terms
        + nodes + node_revisions + node_revision_terms
        + session_links + revision_links + search_chunks_v1
```

Python declares the physical schema. A static, reviewed recursive schema golden is a verification oracle, not another runtime schema owner. Bun compares the Python-created, persisted tables against that golden; no first-row schema inference and no test-time regeneration of expectations. Required names, field order, Arrow types, nullability and nested child structure must be compared.

The existing table-name manifest alone is insufficient: its generic subset/count validator is not an exact-19 or field-level proof. Candidate tests independently assert the literal ordered target table tuple and the replacement equation above.

## 2. Revision and association authority

```text
nodes.current_revision_id --> accepted node_revisions row
                               |
                               +-- canonical scalar content
                               +-- term_snapshot_json (required; [] if empty)
                               +-- link_snapshot_json (required; [] if empty)
                               +-- canonical_version + content_digest
                               |
                               +--> node_revision_terms [derived]
                               +--> revision_links      [derived]
                               +--> search_chunks_v1    [derived]
```

There is no competing whole-revision JSON authority. `schema_version` describes the schema when present; `canonical_version` identifies the eventual canonical-byte protocol. Their exact candidate field declarations are reviewed with the physical golden.

Association projections no longer define canonical revision content. Their deterministic logical keys are `(workspace_name, revision_id, term_id)` and `(workspace_name, revision_id, position)` respectively; a link projection has no independent random ID. Projection meaning follows the revision snapshot, while physical projection rows are replaceable/rebuildable. Reverse lookup must eventually expose stale/incomplete projection coverage.

Projection writes are **not** prerequisites to publishing a verified revision head. This reduces, but does not eliminate, the cross-table publication problem: `nodes` and `node_revisions` still require the #26 visibility, retry, writer-exclusion and crash tests. No transaction or atomic multi-table snapshot is claimed.

`revision_no` is a required Int64 candidate ordinal. Only accepted head/base ancestry gives it accepted-history meaning. Prepared/orphan branches may contain the same ordinal; do not enforce or advertise table-wide `(W,node_id,revision_no)` uniqueness. Normal-read orphan invisibility and ancestry validation remain #26 service work.

## 3. Physical encodings and compatibility

| Concern | Candidate decision / boundary |
|---|---|
| Opaque newly issued entity ID | Existing candidate nanoid21 codec; not a replacement for stable names or legacy integer identities |
| Workspace/peer/session handles | Preserve their explicit name semantics; no inferred peer aliases |
| `messages.id` | Preserve legacy Int64 identity, separate from `public_id` |
| Existing datetime / new time fields | Arrow `timestamp[us]` without timezone, semantically UTC; explicit public UTC-millisecond adapter |
| Retained legacy integer times | Keep Int64, including trace range/created/updated fields and `mcp_calls.created_at`; no silent unit conversion |
| Target Int64 wire | Canonical decimal string; legacy endpoint compatibility remains separate |
| JSON storage | UTF-8 strings; required versus nullable is explicit |
| Search vector | Nullable fixed-size Float32[384] in this candidate; finite row fixture, no model call |
| Search `term_ids` | Explicit string-list physical type with child nullability pinned in the golden |
| Embedding identity | 384 dimensions do not establish model/profile equivalence; complete model digest/input/chunker rules remain open |

The target intentionally removes `traces.distilled_to` and `traces.distilled_at`; they are not retained columns. Canonical conclusion/trace result links are `revision_links`, and any old singular display is derived from those links. Active15 keeps its legacy columns unchanged; migration maps their values to pinned revision links or reports unresolved data rather than introducing another writable result authority.

Retained integer time units are not resolved merely by preserving their Arrow type. Migration must inventory and prove their units/ranges before conversion. Likewise, the timezone-less timestamp type alone does not prove UTC semantics; boundary adapters must enforce those separately.

Message source namespace/ID/digest have all-or-none logical presence; source creation time stays distinct from server ingestion time. Physical nullable columns alone do not enforce that predicate, scoped uniqueness, sequencing or replay outcomes. Evidence JSON storage alone does not prove discriminated target validation or canonical `target_key` equality.

## 4. What the fixture slice may prove

- Exact target19 field structure, separately from unchanged active15.
- All19 Python-created scratch tables reopened and inspected from Python/Bun.
- Required/null/empty values, representative Unicode/Thai text, >JS-safe Int64, times, null vector and a finite 384-dimensional vector survive the tested round trips.
- Incompatible missing/extra fields, integer widths, field nullability, timestamp units/timezones and vector element types/dimensions are rejected by the candidate schema guard.
- Persisted incompatible-table fixtures retain identical schema, version and row count after rejection; no overwrite or repair is implicit.
- Required snapshot columns are parseable array JSON and preserve exact `[]`. A lowercase SHA-256-looking string proves shape only.

The tests must not conflate a model-schema comparison with persisted-state evidence, nor a directory-exists error with schema-drift detection. Representative timestamp round trips are not proof over the entire supported calendar range.

## 5. Historical remaining gates at the physical-slice handoff

Status correction: revision/evidence byte rules were subsequently accepted at `6289311`, and source/legacy boundary mapping at `33e3c44`. The following paragraph preserves the earlier handoff, not the current backlog. See [delivery gates](delivery-gates.md) for current enforcement ownership. No physical field or golden provenance is changed by this note.

At that handoff, #23 still needed complete revision/snapshot canonical byte rules, arbitrary extension-number policy, evidence target contracts/keys, source namespace grammar, error shapes, full operation scope and compatibility adapters. A future revision digest must cover the governed content and complete association snapshots; a placeholder digest string or the existing message codec does not establish this.

#26 must prove head/base publication, idempotent retry/conflict, accepted ancestry/orphan behavior, crash/recovery, service/migrator exclusion and reader refresh behavior. #27/#28 own taxonomy, projection reconciliation and scoped evidence/session/message services. #29/#30 own lifecycle eligibility and derived search reconciliation. Authorization and any R2 write proof remain separate gates.

Copy migration under #34 must explicitly map **memory_terms -> initial revision term snapshots -> derived node_revision_terms**. Preserve association counts/meaning and unknown attribution; reject/report unresolved term links rather than silently omit them. Old vectors may be reused only with proven compatible provenance.

## 6. Acceptance process

Neo-claude owns isolated target implementation and new fixtures; Codex independently reads the diff, runs verification, and decides which claims are supported. No issue is closed or checkbox checked by dispatch or by this design note. Completion reports distinguish PASS, FAIL, and NOT RUN. No live data, active registry, backend, model endpoint, dependency or deployment change is authorized by this slice.

## Amendment 2026-09-26 (overnight R11 + R17)

Appended, not rewritten. Source of the rulings: [`docs/overnight/DECISIONS.md`](../../../docs/overnight/DECISIONS.md) R11, R17 (as corrected 22:00) and R18 D1. Implementation: `app/migrate-py/src/arra_migrate/copy_migration/` (operator CLI `arra-migrate-copy`) plus the Bun worker `app/server/src/migration/worker.ts`. Operator-only: no HTTP route, MCP tool or `app/cli.ts` command reaches it, and `arra-migrate` does not import it.

**What changed.** The #34 copy migration now exists as a rehearsal on a COPY: the original legacy source is hashed before and after (sha256 per file) and must be byte-identical; the migration reads a snapshot copy; the candidate must be a new EMPTY local directory held under `writer_gate` for the whole run (the Bun worker adopts the same held descriptor as fd 42); `://` roots are refused. Every source row of all 15 legacy tables gets exactly one record (`migrated | rejected | unresolved`) and `rows_in == migrated + rejected + unresolved` per table.

- **Memories** become a node plus an accepted first revision through `publishRevision` (Bun is the one canonicalizer). The kernel clock is set to the legacy `created_at`. The node id is always R18 D1 `legacy_node_id = base64url(sha256("arra-legacy-node/v1\n"+ws+"\n"+id))[0:21]`, byte-for-byte what the v3-compatible resolver computes. Other ids are deterministic (`base64url(sha256(domain, kind, workspace, legacy id))[:21]`, kept unchanged when already nanoid21; workspace ids pass through). Every mapping is recorded in `id_map.jsonl`. Author and observer stay NULL; the legacy writer is kept as `internal_metadata.legacy_peer_name` with `attribution_unresolved: true`. No horizon is inferred. Legacy vectors are never reused (no per-row profile exists); `vector_disposition` records why, and chunks are indexed `pending`.
- **R11 type.** A legacy `memories.type` that exactly equals a reserved type term is kept. Anything else becomes `note`, and the original string becomes a term in a per-workspace `legacy_type` tag vocabulary (kind `tags`, open, `many` / not required / `flat`), created through the kernel's taxonomy writers.
- **memory_terms** become entries of the initial revision's term snapshot, and `reconcileRevisionAssociations` derives `node_revision_terms` from it. Rows whose memory or term did not migrate are reported (`memory_not_migrated`, `memory_unresolved`, `term_unresolved`).
- **R17 vocabularies.** Legacy vocabularies are backfilled `cardinality: many`, `required: false`, `hierarchy: flat`. A legacy vocabulary named `type` or `memory_horizon` is rejected per record (`reserved_vocabulary_name`), never merged into the reserved seed; `legacy_type` is reserved by the migration (`reserved_by_migration`).
- **R17 distilled_to / distilled_at.** `traces.distilled_to` becomes a `derived_from` link with `target_kind: trace`, `capture_status: locator_only` and `captured_at: null` on the conclusion revision. `distilled_at` is never invented as `captured_at`; as R17 (corrected 22:00) says, it goes to the distilled revision's `internal_metadata`, as `legacy_distilled[]` entries `{trace_id, legacy_trace_id, distilled_at_ms}` (Int64 as decimal text). A `distilled_to` naming a memory that did not migrate is an unresolved pointer record.
- **Trace status.** The legacy closed set `raw | distilled | retired` is not the trace kernel's closed set `open | complete | abandoned` (trace-v1.md); copied verbatim, every legacy trace reads back as `integrity_failure`. `raw -> open` is ruled (R17, corrected 22:00). `distilled -> complete` and `retired -> abandoned` are an implementer extension that is NOT ruled. The legacy value is recorded on each trace's report record, and `policies.trace_status_mapped` counts them. Overturn by changing `TRACE_STATUS_MAP` in `copy_migration/activity_tables.py`.
- **trace_hits** (R17, corrected): a legacy kind outside the evidence `TARGET_KINDS` (e.g. `file`) is `rejected` (`kind_outside_target_kinds`); a kind inside it is `unresolved` (`locator_unmappable`), because a free-text `ref` does not determine a structured `target` without inventing one.

**Why.** R11 keeps every legacy type string without extending the reserved type vocabulary; R17 fixes the backfill policies the target requires and the legacy schema never recorded. Both rulings say the rehearsal runs on a copy and that the inherited gates stay visibly excluded.

**Not claimed.** No cutover, no R2 support, no recall-quality claim. Every report carries `release_exclusions` for #7 (judgments), #8 (container) and #10's quality half, and `release_ready: false`.
