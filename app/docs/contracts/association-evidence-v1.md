# Association materialization and evidence queries v1 — frozen implementation contract

v4-codex — AI. 2026-09-21. **FROZEN for bounded implementation with a separate exact-file dispatch.** Root owns acceptance; this document is not implementation evidence or parent completion.
Base: main `f9e5abe8ab80514198beac554dd10ef610c0f264`. Prerequisites: the accepted publication, taxonomy, context-ingestion and revision-evidence contracts. This is a further #28 dependency slice, not completion of #28, #26, #27 or #30.

## 1. Authority, scope and composition

Accepted immutable revisions and their digest-verified complete snapshots remain authoritative. Publication stays projection-free. Materialization may change ONLY derived `node_revision_terms` and `revision_links` for an explicitly requested accepted revision. It cannot alter a revision, node head, taxonomy definition, source message, capture annotation or evidence identity. No schema change, durable watermark, operation journal, physical index claim, model, network fetch, transport activation or new dependency.

Factories are `openEvidenceReader` and `openEvidenceWriter`. Existing factories retain their exact key sets. The new writer bundle is `{publication,taxonomy,context,evidence,close}`; the reader is `{publication,taxonomy,context,evidence}`. Nested facades never carry close. Share the existing private owner, serial queue, attempted-write flag, poison and cached close. Evidence reads bypass the queue, survive poison, and fail after release. All factories contend on the same gate/registry. No owner/adapter/connection/table/token constructor escapes.

`openEvidenceWriter(datasetRoot, options)` takes the existing ContextOptions (including explicit sourceNamespace string or null) plus optional trusted `onEvidenceBoundary(boundary)`; the callback receives ONLY one of the seven closed strings in section5, never rows/handles/indices. `openEvidenceReader(datasetRoot)` needs no gate and has only the two evidence reads on its evidence facade. Existing option behavior stays unchanged. No new clock/ID allocation is used by evidence reconciliation: all values derive from retained snapshots. Exact runtime service exports become PublicationError, openContextReader, openContextWriter, openEvidenceReader, openEvidenceWriter, openKnowledgeReader, openKnowledgeWriter, openPublicationReader, openPublicationWriter, sorted as written.

This remains an operator-only local kernel. Workspace predicates are isolation checks, not authentication. Future #25/#31 admission must constrain requests and rendering before exposure; no callback that claims arbitrary permission is introduced. No denied object/count/identifier guarantee is credited until that integration is exercised.

## 2. Methods and request grammar

All methods accept strict UTF-8 `Uint8Array` request bytes, <=1MiB/depth64, existing governed parser and closed-object validators. Null is explicit; no copied parser. Workspace and nanoid grammar are reused. Method keys below are exact:

- `getRevisionAssociations({workspace_name,node_id,revision_id})`: revision_id nanoid or null (captured head). Absent node returns null; an explicit revision not on accepted ancestry returns null, never a raw orphan. Invalid stored ancestry fails. Returns the selected revision identity, digest, captured head ID, `is_snapshot_head`, and complete normalized term/link projection rows in position order. Physical projection absence cannot remove an entry.
- `scanDependents({workspace_name,target_kind,target,revision_mode,limit,cursor})`: typed target accepted by `targetOp`, revision_mode exactly `current` or `history`, limit JSON integer 1..100, cursor null or the closed continuation described below. Returns occurrences, not deduplicated revisions. No raw caller-supplied target key.
- Writer only: `reconcileRevisionAssociations({workspace_name,node_id,revision_id})`: revision_id is required nonnull nanoid. Resolve the workspace and requested node/accepted ancestry first; missing mutation target/reference is publication invalid_reference at its input pointer. Orphans are not materialized into apparent acceptance. Derive the complete expected sets from the selected immutable revision.

Exact result objects:

```text
getRevisionAssociations => null | {
  workspace_name, node_id, revision_id, content_digest,
  snapshot_head_revision_id, is_snapshot_head, terms, links
}
reconcileRevisionAssociations => {
  outcome: "reconciled" | "already_satisfied",
  workspace_name, node_id, revision_id, content_digest,
  terms: {action:"unchanged"|"filled"|"rebuilt", count},
  links: {action:"unchanged"|"filled"|"rebuilt", count}
}
scanDependents => {
  outcome:"page", nodes_version, occurrences, next_cursor
} | {outcome:"restart_required"}
occurrence = {
  workspace_name, node_id, revision_id, revision_no, content_digest,
  snapshot_head_revision_id, is_snapshot_head, link
}
```

`count`, `revision_no`, positions and nodes_version are canonical nonnegative Int64 decimal strings (revision_no/version positive). Count is the complete expected final set size, not a historical counter of SDK writes. All objects are closed; booleans are literal. `terms` and `links` on the reader are arrays of the exact physical wire rows below. Link on an occurrence is one such complete row. No live source-availability claim is added.

## 3. Row derivation and reading

Reuse revision verification with digest recomputation, normalized complete snapshots, `targetOp` and `verifyTargetOp`. Exact physical wire field order:

```text
term: workspace_name, revision_id, term_id, vocabulary_id,
      vocabulary_name_snapshot, term_name_snapshot, label_snapshot, position
link: workspace_name, revision_id, position, relation, target_kind, target,
      target_key, excerpt, content_hash, captured_at, capture_status, note
```

There is no invented link ID. Derive target text and target_key from the SAME codec result. Compare parsed target with the normalized snapshot entry. Preserve all annotations, explicit nulls and display values; ordinary capture annotations are not identity and are not proof of retrieval. Relic-event capture_digest IS part of identity.

Int64 and timestamp conversion reuse reviewed exact wire rules. Historical rows must not be revalidated against today's term names/activity/policy. A missing current source row is not a missing citation; this API does not dereference sources and does not assert they remain available. `captured`, `locator_only` and `unresolved` are retained claims, not live access checks.

`getRevisionAssociations` returns the complete expected sets from the snapshot, without a claim that physical projections are complete. Missing/duplicate/wrong derived rows cannot change authoritative association content. It does not read source bodies or fetch captures. A missing source and a missing projection remain distinct storage conditions, but neither is automatically converted into a fabricated availability status in this immutable-citation response. The mutation result, not the read response, acknowledges verified materialization.

Reverse results retain `(workspace_name,node_id,revision_id,link.position)` occurrences plus the link row and captured-head witness; there is no duplicate top-level position field. Multiple positions targeting the same identity remain separate. Different annotations are not merged; different capture identities remain separate. Current mode selects each captured head only, so is_snapshot_head is always true. Current means head, not an active/unsuperseded recall-eligibility filter; this evidence API does not invent lifecycle filtering. History mode selects all accepted ancestors, oldest first per node, with `is_snapshot_head` explicit: one unchanged citation carried through N accepted revisions is N distinct historical occurrences, not a duplicate bug. Passive/locator-only/unresolved citations are included, not filtered away.

## 4. Reverse completeness and continuation

Do not answer completeness from projection candidates. Enumerate workspace nodes, verify accepted ancestry, and derive links from snapshots even when projection rows are absent. This is a correctness-first scan, not an indexed performance claim. A later acceleration needs separate coverage proof.

**Read invariant:** neither evidence read method queries `node_revision_terms` or `revision_links`. Materialization only changes those derived tables, so it cannot change either authoritative response or the nodes-version witness. Any future accelerated read path needs its OWN coverage/consistency protocol; it cannot inherit this witness while starting to depend on independently changing projections.

Stable traversal order is node ID ASCII ascending, then numeric accepted revision ordinal ascending, then numeric link position ascending. Enumerate IDs with the existing private ordered projection shape, fixed workspace predicate, exclusive keyset predicate and bounded lookahead. Every selected node identity must be checked with 0/1/>1 discrimination; duplicates at a page edge cannot be silently skipped by keyset advancement.

Capture the nodes table version after explicit refresh. The page nodes_version and every nonnull returned cursor.nodes_version must equal that SAME captured version; they are not independently sampled values. Each page checks it again after all reads and before returning, and a continuation must match the captured version before it reads data. If it changed, return a closed `restart_required` value with no occurrences from this page. The consumer must discard its accumulated scan and restart from null. No automatic unbounded retry. The rule is conservative: a change elsewhere in the same table can invalidate an operator scan. This witness is NOT a multi-table transaction or an authorization capability. Revisions already selected by an unchanged head are immutable under the cooperative writer protocol; orphan appends do not themselves change acceptance.

The proof premises are explicit: every accepted publication changes nodes (first-node append or guarded head update), accepted revision rows are immutable and retained, and materialization touches only derived tables that these reads ignore. Same-UID out-of-protocol edits, table replacement/restore or later acceptance paths that do not change nodes are outside these premises, not silently covered by the scan. A table version can advance on a no-op write; that causes a conservative restart, not evidence that content actually changed. `restart_required` intentionally carries no progress or churn diagnosis; callers choose a finite retry budget and must not infer completion from repeated restarts.

**Measured prerequisite, bounded:** neo's keyset/version probe and root's independent rerun assert ASCII order, scoped pages and equality count2 at a duplicate boundary; nodes versions moved2→3→4 for a second owned process appending then updating. Existing reader handles with readConsistencyInterval0 saw change even without explicit refresh. This is single-table local evidence, not a transaction proof. Version checks must still explicitly refresh and observe state at both boundaries. Root output is `issue28-keyset-root-output.json`; runner exit was checked before literal assertions.

Exact cursor:

```text
{
 workspace_name, target_kind, target_key, revision_mode, nodes_version,
 node_id, revision_no, position
}
```

node_id is the last examined node; revision_no and position are nullable. Both null mean this node was fully examined. Positive revision_no with position null means that revision was fully examined. Positive revision_no with nonnegative position means examination reached that link position, inclusive. Position cannot be nonnull when revision_no is null. Resume strictly AFTER this boundary, never after the last *matching* occurrence alone. Empty revisions therefore advance. A call does not emit a cursor before doing any work: if the first required item cannot fit, it fails limit_exceeded instead.

All fields are closed and validated; target/mode/scope disagreement is governed scope_mismatch at the corresponding cursor pointer. In particular, cursor.target_key MUST equal the target key derived by targetOp from THIS request's typed target; otherwise scope_mismatch at `/cursor/target_key`. It is not an alternate raw-key lookup. At the same nodes version, the cursor node must resolve uniquely and the referenced ordinal/position must belong to the selected mode and accepted snapshot; invalid boundary values are publication invalid_request at their cursor pointer, while stored duplicates/corruption remain root integrity_failure. Cursor fields are request data, not proof of admission or proof that a caller actually consumed earlier pages. `next_cursor:null` means only the REMAINING scan after this request's boundary is exhausted. The API never certifies that a caller-chosen starting cursor visited the whole workspace. Future public opaque-token mapping is a separate adapter concern.

**Completeness condition:** on the SAME dataset and unchanged request scope/target/mode, a scan starting at cursor null, passing each returned cursor unchanged to the next request, receiving only page results at one nodes_version, and ending at next_cursor null has visited every node in that workspace at that version and returned every matching occurrence in the selected revision mode, exactly once. Any restart_required invalidates that accumulated scan. Altered/foreign cursors or omitted pages do not satisfy this condition. No single noninitial page claims whole-workspace completeness.

Bound each call by at most32 visited node identities INCLUDING a resumed partial node,128 selected revisions INCLUDING a resumed partial revision,4096 examined link positions, requested result limit and16MiB response wire bytes. Stop at a deterministic continuation boundary without omitting the first unprocessed occurrence. A page can be empty while continuation is nonnull; clients must not interpret that as no dependents. Existing per-node ancestry limits1024/16MiB remain. Verifying a selected node's full accepted chain still validates its ancestors/snapshots even in current mode; the selected-revision and examined-link counters describe enumeration, not a claim that the canonical verifier examined no other bytes. Retain at most one node's full chain at a time plus the bounded response. Enforce cumulative response bytes incrementally; a single unrepresentable item fails limit_exceeded rather than spinning on an unchanged cursor. These are application traversal/materialization limits, not a bound on SDK scan work or wall-clock latency. No maximum total workspace size is introduced by pagination.

Fetch a cursor's partially examined node inclusively when revision_no is nonnull; otherwise enumerate strictly greater IDs. An initial null cursor starts before all IDs. Treat the last completed revision or last examined link as a usable boundary; there is no need to emit an unexamined node. Budget counters reset per request, so a valid emitted cursor can always make progress on a stable dataset. Verify uniqueness of every selected node, not just the terminal cursor. Node versions received from the SDK must be positive safe integers before conversion to decimal text, not rounded into a token. Both successful result variants and the whole forward response are capped at16MiB compact JSON UTF-8 bytes; exact equality is allowed. On byte overflow with an existing prefix, emit that prefix and its last examined boundary; never advance over the omitted matching occurrence. If no matching occurrence was accepted and the next item alone exceeds the cap, fail limit_exceeded. Cursor/control-field bytes count toward the response cap too.

## 5. Derived-row reconciliation

This operation is the FIRST materializer, not repair between pre-existing product writers. No operation ID is required: the immutable verified snapshot fixes the expected state. Under the existing writer gate/queue:

1. Validate request, workspace, unique node and complete accepted ancestry. Derive expected rows. Read both scoped projection sets with enough lookahead to distinguish an exact set from excess rows. Compare every field, not just keys/digests/counts.
2. If both sets match exactly, return already_satisfied without mutation boundaries or allocations.
3. If an existing table set is a matching subset, append only missing rows in position order. Preserve every matching row byte-for-byte.
4. **Explicit implementation scope:** if a derived set contains conflicting, duplicate or unexpected rows, replace that table's complete `(W,revision_id)` set, never another revision or workspace. The planned private scoped delete capability is now supported by documentation and a disposable-fixture probe; it remains absent from accepted product source. This contract specifies replacement, so rebuilt is reachable in the implementation. Product edits still require the separate exact implementation dispatch.
5. Process terms then links. For replacement, delete the scoped derived set, verify it is empty, then append expected rows in position order. Verify each write and finish by comparing BOTH complete sets with the expected rows. No ACK for a count-only match.

A crash may leave absent/partial derived rows. Snapshot-based reads remain complete; a fresh owner re-derives and resumes. This changes no accepted snapshot and is not partial authoritative association publication. Reader completeness must be tested while the materializer is parked after deletion and between appends, not inferred from final green state. Full-column distractor preservation belongs in those independent fixture tests, across both another revision and another workspace. Sampling two unrelated rows in production would not prove no over-delete elsewhere and is not added as a false global safeguard. Predicates use only fixed field names plus the existing reviewed literal escaper. DeleteResult.numDeletedRows must be a nonnegative safe integer: compare exactly when pre-read exhausted the scoped set; if expected+1 lookahead was reached, compare only against that observed lower bound. In both cases require a refreshed empty scoped set before reinsertion. A table version is not a row-count substitute.

Any attempted delete is an attempted mutation for the shared fail-stop rule. Unknown/ambiguous write/readback/hook failure poisons all mutation facades; errors escape the serial turn. Preserve actual safe error classes and exact envelopes. No rollback claim. A later owner can retry; the same poisoned owner cannot. Publication never calls this operation internally.

Boundary firing: `before_delete`, `after_delete`, `after_delete_readback` fire once per table actually REPLACED, never for a filled or unchanged table. Each appended row fires `before_write`, `after_term_write|after_link_write`, `after_readback`. ALL term-table boundaries finish before ANY link-table boundary. No boundaries for skipped matching rows or final all-set verification. For a rebuilt table with N expected rows the trace is one delete triple then N row triples; for a matching subset with M missing rows it is M row triples only; unchanged is silent. Zero-row rebuilt tables still fire the delete triple. Independent tests must assert persisted scoped identity prefixes and complete response action fields, not only event totals.

## 6. Errors and response bounds

Reuse governed ContractError for strict/codec input failures, and the accepted PublicationError subset used by context for service/owner failures. Do not invent a new envelope or misuse the node-specific not_found message. Stored authoritative corruption is root integrity_failure. Derived divergence is reported/repaired only as explicitly specified above, not mistaken for authoritative corruption. Throwing safe errors after attempted writes preserves their actual class/toJSON while poisoning.

Wire `toJSON` is exactly version/code/path/message with no fabricated name. Tests also assert name on actually thrown instances. Re-anchor only where the accepted codec requires input pointers; preserve message. Returned restart-required and already-satisfied classifications are values, not thrown error envelopes.

Permitted publication codes are invalid_request, invalid_reference, integrity_failure, writer_unavailable, unsupported_dataset, recovery_required and limit_exceeded with the existing fixed messages. Exclude not_found. New cursor-context scope_mismatch diagnostics are actual governed ContractError with the fixed message `evidence cursor does not match request`; compare workspace_name, target_kind, target_key and revision_mode in that order, at their respective `/cursor/...` pointer. Preserve any existing target codec diagnostic rather than replacing its message. Static request validation precedes owner work; mutation precedence is request validity, workspace, scoped node/ancestry/revision identity, expected projection derivation, current scoped projection preflight, persistence. Reads validate static cursor shape/context first, then check version before semantic cursor boundaries; a stale version returns restart_required rather than trying to reinterpret a cursor against changed heads.

## 7. Discriminating evidence

- Two traces/two sessions; two nodes, repeated citing positions, cross-workspace and cross-kind distractors; exact occurrence sets, not counts alone.
- Same Relic location with two capture digests retained, display-only changes same identity, annotations and multiplicities preserved.
- All projections absent, one missing, wrong field, wrong target_key, duplicate and extra rows; snapshot-derived answers unchanged and materialization state honest. Real derived rows must be written by the materializer.
- Old and new revisions differ in links; current/history answers labelled; accepted history survives term rename/retirement; raw orphan projections invisible before publication and visible only through accepted ancestry afterwards.
- Multi-page scans including empty nonterminal pages, exact budgets, ASCII order, duplicates at boundaries, changed nodes version before/inside/between pages forcing restart and no mixed successful continuation.
- SIGKILL at each actual delete/append/readback point; fresh-owner retry identical rows without duplicates; reads while parked never expose partial association content. Real SDK failure with filesystem repair before same-owner refusal.
- Publication regression explicitly still writes no projections; new factories contend with all old factories; same shared poison/close/reads behavior, no expanded raw runtime exports.
- No network/model/capture-truth/permission claim from these tests. Parent acceptance involving real admission, recursive access bounds, session links, traces/cursors and Relic remains open.

## 8. Ownership and freeze gate

Exact ownership, effective ONLY with separate matching-SHA dispatch:

- **Neo, serialized core:** `app/server/src/publication/service.ts`, new `app/server/src/publication/association.ts`, new `app/server/test/association-service.test.ts`, new `app/server/test/helpers/association-fixture.ts`, new `app/server/test/fixtures/association-v1/core/**`; plus `app/migrate-py/tests/test_revision_v1.py` ONLY inside IsolationTests for the exact association module helper exemption/import pattern/independent sensitivity sample. No directory exemption and no unrelated test-class edits.
- **Ownership:** new `app/server/test/association-ownership.test.ts`, new `app/server/test/fixtures/association-v1/ownership/**`; and ONLY the literal seven-to-nine allowed runtime exports amendment in accepted `app/server/test/taxonomy-ownership.test.ts` (plus its optional count-word comment). Insert openEvidenceReader and openEvidenceWriter in sorted position, preserve exact equality and forbidden-capability assertion. Apply only at the first source sync containing both factories.
- **Recovery:** new `app/server/test/association-recovery.test.ts`, new `app/server/test/fixtures/association-v1/recovery/**`.
- **Fixtures/query:** new `app/server/test/association-query.test.ts`, new `app/server/test/fixtures/association-v1/query/**`; plus accepted `app/server/test/fixtures/context-v1/precision.test.ts` ONLY for the exact seven-to-nine runtime-export array amendment (insert openEvidenceReader and openEvidenceWriter between openContextWriter and openKnowledgeReader) and its test title seven-to-nine correction. Preserve every other byte, including exact equality.
- **Root:** this contract installed as `app/docs/contracts/association-evidence-v1.md`, planning/verifier/evidence files outside product ownership, exact sync/integration and acceptance.

This is ten exact non-document paths plus four fixture prefixes and the root document. storage.ts, all physical models/goldens, protected codecs/errors, accepted helpers/exporters, package/lockfiles, runtime/transports and all other accepted tests remain frozen. Extend only the module-private service adapter with a delete capability restricted to the two named derived tables and fixed W+revision predicate construction; do not add an exported generic delete/query or raw owner interface. The pure association module imports no SDK or authority. Fixture helper wraps the accepted bare/context fixture and bounded gated-child helpers; no second Python creator. Root new verifier must check these exact boundaries and stable before/after hashes.

Readiness inputs were completed by ownership (cursor/progress), recovery (replacement/hooks) and neo (literal API/private adapter feasibility), with dispositions recorded in the root planning notes. Product behavior remains unproven until independent tests and root stable-tree acceptance. A separate dispatch names this contract SHA, exact base, worktree and owned paths; this document alone is not a commit/push/merge instruction.

Ownership-only correction after first full acceptance: the original freeze SHA `b4a9660de8e1d669396769f12973284973661fced86214e5f7b447b785e83f1e` omitted the accepted context precision export assertion. The stable 694-pass/1-fail run exposed that root scope omission. This correction authorizes only the additional exact test transform above; sections 1-7 and all product semantics are unchanged. The verifier derives both export amendments from the accepted baseline and rejects all unrelated bytes. Original evidence remains preserved.

## 9. Private delete reference evidence (not execution proof)

The read-only researcher verified installed0.38.0 declarations: `Table.delete(predicate:string): Promise<DeleteResult>` and `{numDeletedRows:number,version:number}`, with the JS wrapper forwarding to native. [Official Table.delete](https://lancedb.github.io/lancedb/js/classes/Table/#delete) and [DeleteResult](https://lancedb.github.io/lancedb/js/interfaces/DeleteResult/) agree; exact-version evidence is the installed package plus upstream tag v0.38.0 commit `8c68e0c619f2b1febe92e51a29d72c968d24a5c9`. [Read consistency documentation](https://lancedb.github.io/lancedb/js/interfaces/ConnectionOptions/#readconsistencyinterval) describes interval0 checking external changes on reads.

These references do not prove our escaped predicate, zero-match version behavior, scoped distractor preservation, or delete/rebuild crash behavior. Neo's separate bounded planning probe measures exact W+revision deletion of disposable derived rows, including an apostrophe workspace, duplicate target rows and other-scope distractors. Its repaired runner compares all8 term and12 link fields; the original four-field comparison is recorded as narrower evidence, not full-row equality. Measured deletes removed4 term rows and2 link rows, preserving independently authored distractors; zero-match delete returned0 yet advanced the table version3→4. The driver now throws on nonzero child exit so finally cleans its creation-record root. Note SHA `05c562ea89c76aa78297206cfef86636d6d2e82469dbf934c4c5c2567e24c562`. No product or accepted authoritative row was edited. Product fault tests must later prove recovery, not inherit it from this uninterrupted API probe.
