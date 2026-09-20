# Local target revision publication v1 — reviewed implementation contract

v4-codex — AI, design/verification lead. 2026-09-20.

This reviewed contract defines the first real #26 persistence slice, including first-node creation. It is not implementation evidence or issue closure. It takes effect for implementation only with the separate root-owned bounded dispatch and matching SHA. Independent critique approved the planning text at SHA0b9146744b30db9fd55c3408768ac452c1bd98751b053d408c52c2a82bca1117; this frozen copy changes only review/status wording.

## 1. Scope and unchanged authorities

Implement publication/read/recovery against an explicit local COPY containing the reviewed target19 tables and 228 fields. Keep active15 runtime, HTTP/MCP/CLI/browser and live datasets untouched. No activation, R2, network filesystems, new dependency, new table/column, SQL FK, multi-table transaction or multiwriter claim. No projection/search/model call on the authoritative path.

Python still owns physical schemas. Reuse existing canonical revision/evidence codecs and their exact bytes, versions, snapshot formats and error vocabulary. A publication request does not change the governed envelope. A separate service-error envelope below must not silently add codes to the protected closed `arra-error/v1` codec.

This is an internal local persistence kernel. A future caller must enter through #25 credential-taking service admission before invoking it; no new route or bypass around that facade is introduced here. The operator-owned local worker and test IPC are not user-facing authentication surfaces. #25 remains open for target-service access/reference integration, #27 owns taxonomy-management APIs and #28 evidence/ingestion product APIs.

## 2. Stable identities and interface

Three internal methods:

1. `publishRevision(requestBytes: Uint8Array)` — strict JSON closed outer object `{operation_id,content}`; `content` is the existing closed 21-key raw-column envelope consumed by `revisionOp`.
2. `getAcceptedHead(requestBytes: Uint8Array)` — strict JSON closed outer object `{workspace_name,node_id}`; return exactly `null` if the node is absent, otherwise `{node,revision}`.
3. `listAcceptedHistory(requestBytes: Uint8Array)` — the same strict read request; absent returns `null`, otherwise `{node,snapshot_head_revision_id,revisions}` with the complete accepted ancestry oldest first. No raw orphan list.

Each method calls existing `parseStrictBytes` with maxBytes1048576/maxDepth64 before closed-object validation. Pass the resulting Map content directly to `revisionOp`; no authoritative plain-object/JSON.parse entrypoint, alternate parser, new existing batch-worker op or HTTP route. Reject non-Uint8Array input as a contract invalid_type at root. A null-head physical node is an integrity failure, not the absent null result.

Read `node` is exactly the five target Node columns; `revision` and each history item are exactly the26 target NodeRevision columns. Preserve the five JSON-valued columns as their stored canonical strings/null, not a newly invented nested response. Encode physical Int64 values (including schema_version/revision_no) as canonical decimal strings and timestamps as exact UTC-millisecond strings. current_revision_id and snapshot_head_revision_id both name the node head captured for THIS read, not a promised latest head after it completes. Service factories expose only these methods plus writer close; raw handles remain private.

The caller retains a stable `node_id` (existing nanoid21 grammar) and exact `operation_id` across retries. Operation grammar remains nonempty valid Unicode, NOT an invented nanoid-only restriction; namespace is the exact tuple `(workspace_name,"node_revision",operation_id)`. No trim, case folding, concatenated composite keys or regenerated IDs on retry. Workspace uses the reviewed authorization grammar (nonblank valid Unicode, at most 256 UTF-8 bytes). Total request JSON has a 1 MiB raw UTF-8 bound and depth64 via the existing strict parser; keys/values that exceed this fail before any dataset mutation.

`base_revision_id:null` means first publication. A nonnull base means append to the existing node, never create a node or silently branch. Revision IDs, ordinal and creation timestamps are service allocation state, rejected from the content envelope as today. No standalone `allocateNode()` API and no new headless node write.

Result classification:

```
accepted | idempotent:
  outcome, node_id, revision_id, revision_no (Int64 decimal text),
  content_digest, node_created_at, revision_created_at

conflict:
  outcome:"conflict", reason:"operation_digest"|"node_id"|"stale_base"
```

No conflict means success was applied; it is a successful conflict classification. An idempotent retry returns the ORIGINAL accepted revision/creation values, even after a later head exists. It does not update timestamps or pretend the original revision is current. Call getAcceptedHead separately for that.

Creation timestamps are trusted exact UTC millisecond strings from one injected service clock sample for a new revision. Physical columns remain timestamp[us] with no timezone: multiply millisecond integer by1000 without floating-point rounding. All retained physical Int64 values use BigInt/Arrow, never unsafe JS Number. Read timestamp microseconds from Arrow raw storage; reject a nonzero remainder modulo1000 BEFORE Date/accessor conversion, including year9999 boundaries. Existing persisted-fixture precision tests are a precedent, not a substitute for new persistence round trips.

## 3. Actual local writer exclusion

All target writers, including Python creation/migration helpers used by this slice, acquire the SAME dataset gate BEFORE opening a writable connection. Readers are separate read-only-by-interface objects and never export raw handles.

Supported first deployment is local Darwin/POSIX, product Python3.12.13 and Bun1.3.14. The measured prerequisite in planning `revision26-lock-probes/` demonstrated Python flock inheritance through exec to Bun and kernel release after owned-process death. It did not prove Linux/NFS/R2, node:child_process variants or malicious same-UID safety.

- Resolve the existing dataset directory to its canonical real path; aliases to that directory share the same lock location and inode identity. Reject URLs/remote storage and any default/fallback ARRA_DATA_DIR.
- Persistent internal lock file `.arra-writer.lock`, created/opened safely with no symlink following, checked on the same descriptor as a regular file owned by the current UID with mode0600 and one link. Never unlink, steal or replace the file during normal acquire/release; existence is not ownership.
- Python uses exclusive nonblocking `fcntl.flock`. A contender fails `writer_unavailable` before dataset connect/mutation. Dup to inheritable fd42, retain it through exec of the owned Bun worker. Bun checks descriptor/inode/root identity before connect and refuses an ordinary unwrapped launch without the descriptor. Environment fields locate/configure the inherited descriptor; they are NOT cryptographic proof of ownership. Correct trusted launcher participation is part of this local operator TCB.
- A single owner registry keyed by canonical dataset identity plus a serial promise queue prevents two owners/operations inside one Bun process. An opaque owner must be minted internally; no exported constructor accepting a caller-asserted owner/context. A close waits for in-flight work before releasing fd; queued work is rejected. No timeout lease or automatic stale-lock deletion.
- Every fault-test child has a parent-enforced monotonic deadline, exact owned-PID kill/reap and cleanup. Never kill a port/process by a broad pattern. Do not inherit the lock into long-lived children intentionally. The installed Bun.spawn non-inheritance observation is bounded runtime evidence, not a universal descendant guarantee.

First mutation requires exact target schema verification against the independent golden for all19 tables. Reject an active15 or drifted dataset without modifying schema/version/rowcount. Existing source paths must not import/activate this worker. No migration overwrite/reset option.

## 4. Acceptance is head ancestry, not row presence

Acceptance is relative to the unique `(workspace_name,node_id)` row being requested and ITS captured head. Follow base_revision_id backwards within that SAME workspace and node. Do not certify that no unrelated corrupt node elsewhere points at an ancestor; that foreign node fails when its own chain is read. Every visited row must be unique by scoped revision ID, canonical-byte/digest valid, and have a positive exact Int64 ordinal; first ordinal1/base null, successors exactly predecessor+1. Reject missing rows, duplicate scoped node/revision/operation identities, cycles, cross-node/workspace bases or heads, invalid canonical columns/digests, and overflow. No raw physical orphan is a normal result.

Bound ancestry at1024 rows and16MiB of wire-encoded revision rows per requested node in this first internal API. Chain wire bytes are the compact JSON byte length of the exact `revisions` array returned by `listAcceptedHistory`: start at2 bytes for `[]`; for each revision add one comma after the first plus `utf8ByteLength(JSON.stringify(encodeRevisionRow(row)))`. `encodeRevisionRow` emits the exact26 closed NodeRevision fields in target physical-schema order after Int64/timestamp wire conversion. The enclosing `{node,snapshot_head_revision_id,revisions}` object is NOT counted. Reject when the total is GREATER THAN `16 * 1024 * 1024`; equality is accepted. Check cumulative bytes during traversal and stop on overflow instead of first assembling a full history array/string. One fetched row may cross the budget; this is not a process-memory sandbox. Publication computes the existing chain total incrementally and adds the prospective row before append. Exceeding either bound fails closed with publication `limit_exceeded`, never a truncated history. Require exact16MiB accepted and16MiB+1 rejected-before-mutation tests. Pagination/large-history optimization is later work.

All ordinary reads capture/refresh nodes FIRST, then refresh/query node_revisions. Once captured, the chosen head remains the reference for that read even if a writer advances it; immutable retained revisions make a complete old chain valid. A fresh later head with missing/inconsistent revision bytes is integrity failure, never an empty or partial success. Use installed readConsistencyInterval:0 plus explicit checkoutLatest at these boundaries. Record table versions individually; they are not a shared cross-table sequence or snapshot transaction.

Historical accepted content is validated against its OWN frozen snapshots/digest. Do not reject history or old idempotent replay merely because a term was renamed/retired or today's taxonomy policy differs. Live reference/policy validation below is for a NEW publication or resuming an unpublished orphan.

## 5. Validation before persistence

Under the writer gate and within the serial queue: strict request validation/canonicalization; exact scoped operation lookup; stored operation/ancestry validation; then new-operation base/reference checks. Operation lookup outranks a stale current base on an accepted retry.

Any lookup expecting a unique logical identity must distinguish 0/1/>1 matches, not use `limit(1)` to conceal duplicates. SQL predicates are composed from reviewed fixed field names and escaped validated values; never interpolate raw SQL from requests. IDs are not access permissions.

For newly accepted content:
- Exactly one workspace row by name. Nullable author/observer/subject each resolve to exactly one `(W,peer.name)` when present; session_name likewise `(W,session.name)`. No inference of principal into these domain fields.
- Every term resolves by `(W,term.id)` to the supplied vocabulary_id; that vocabulary resolves by `(W,vocabulary.id)`. Require active terms for new assignments and exact snapshot vocabulary name/term name. `label_snapshot` MUST be null for new publication and unpublished-orphan resumption: Term has no authoritative label column, while Vocabulary.label labels a vocabulary, not a term. Do not conflate them. Historical accepted canonical nonnull label snapshots remain readable/idempotent unchanged; #27 may later version a nonnull source policy.
- Validate workspace vocabulary policy fields: kind in tags/categories, term_policy in open/sealed, cardinality in one/many, hierarchy in flat/tree, required a Boolean. Resolve unique `(W,vocabulary.name)` and `(W,vocabulary.id)`; duplicate names/IDs or malformed policy are integrity_failure. Enforce maxone assignment per cardinality=one vocabulary and at leastone for EVERY required=true workspace vocabulary. A sealed vocabulary still permits assignment of an existing active term: sealing governs term creation, not assignment.
- Exactly one reserved type vocabulary must exist and exactlyone snapshot term must belong to it. memory_horizon may be absent; if present it must be unique and at mostone assigned term may belong to it. These reserved assignment constraints apply even if policy columns were permissively configured. No automatic term creation or silent payload rewriting. Require explicit type in this low-level API; user-facing default-to-note sugar belongs to a later adapter. Hierarchy repair/mutation is outside this slice; refs do not license reparenting.
- Internal link kinds are checked within W: node_revision requires matching target node plus accepted target revision in its ancestry; message requires exact session+public_id and valid session; session requires exact name; trace requires exact ID. Missing, cross-workspace or ambiguous refs fail. No all-allow callback or fabricated existence fixture is sufficient evidence.
- Other kinds remain validated passive external locators. Do not fetch, resolve Relic, call a model or assert capture truth. Capture hashes/status prove only the already-reviewed byte/shape contract. New evidence-access/dereference authorization remains #25/#28, not supplied by this local kernel.
- If both validity bounds are present require valid_from < valid_to. Retain activity/attribution/body/snapshot bytes exactly as canonicalized, not silently repair semantic errors.

Accepted historical rows never need to acquire a new publication ordinal or match live labels again. Service reference tests must independently seed two workspaces, not query fake maps that always say yes.

## 6. Replay and first-node collision matrix

Exactly one existing operation row in W:
- Different content digest: `conflict/operation_digest`, no write.
- Same digest and reachable from current accepted ancestry: `idempotent` original result, regardless of later head/base.
- Same digest but unpublished: resume the SAME stored revision ID/ordinal/timestamp after validating its full canonical bytes and present publication preconditions. No new row allocation.
- Missing node after first-revision append is a recoverable initial orphan, not an accepted node.
- Duplicate operation rows, malformed row/digest, incompatible node identity or ancestry: integrity failure; do not select one arbitrarily.

No existing operation:
- base null + absent node + no other revision claim on `(W,node_id)`: first creation.
- base null + node already accepted, or another operation's orphan claims that ID: `conflict/node_id`.
- nonnull base + absent node: not_found; present node with different current head: `conflict/stale_base`.
- Unknown-provenance headless node: reject integrity_failure rather than guessing who allocated it. This slice creates none. Do NOT add a caller-controlled adopt flag. If copied fixture migration must support headless seeds, give that a separate reviewed operator preparation contract; ordinary publication does not silently claim them.

For same-operation orphan resumption: absent-node first creation may resume only if no conflicting revision claim/node appeared. An existing-node orphan may resume only when the scoped current head still equals its stored base. Otherwise stale_base conflict, leaving the orphan hidden. Same-workspace operation IDs are independent of operation IDs in another workspace and of supersession operations.

## 7. Publication sequence and durability boundary

Existing headed node:
1. Complete all validations, choose unused scoped revision ID, calculate base ordinal+1, and sample creation time once.
2. Append ONE complete canonical node_revisions row (both required snapshots included).
3. Explicitly refresh and read it back by scoped ID and scoped operation; require one identical complete canonical row/digest/allocation state.
4. Refresh nodes, apply conditional update for exact `(W,node.id,expected current_revision_id)` setting ONLY current_revision_id and updated_at; require rowsUpdated===1.
5. Fresh nodes-then-revisions readback verifies the resulting complete accepted chain and exact new head before ACK.

First node:
1. Same validations/operation lookup; supplied stable node ID is absent/unclaimed; choose first revision ordinal1/base null.
2. Append+verify revision FIRST exactly as above.
3. Recheck node absent under the same writer ownership; append ONE Node ALREADY HEADED at that revision. Set Node.created_at and updated_at to the stored revision.created_at.
4. Fresh exact node/operation/ancestry readback before ACK.

No new unbound headless allocation exists. A crash between steps2/3 leaves an invisible but durably operation-bound revision orphan. A retry reuses its timestamp and ID. Concurrent callers serialize: a different first operation for the same node ID conflicts, never creates a duplicate node.

LanceDB0.38 add returns a table version; update returns rowsUpdated plus table version. This guarded head update is meaningful under the external writer gate; it is NOT advertised as an independently documented multiwriter CAS. A cross-table transaction is neither requested nor claimed.

Any thrown/ambiguous persistence outcome, unexpected affected-row count or failed post-write readback enters recovery_required/fail-stop for that owner. No further queued mutation may run. Close/release safely; a fresh owner/connection inspects durable state before deciding retry. A request ACK means readback verified SDK-committed table state; tests cover process death, not power-loss/filesystem-hardware guarantees.

## 8. Recovery and service errors

No delete, in-place revision patch, rollback-overwrite or orphan cleanup. Fresh owner reconstructs acceptance from node heads plus immutable rows. It may retry the supplied operation only under the matrix above; it does not auto-publish all orphans on startup. Duplicate/corrupt states fail closed, preserving evidence.

Strict parsing, closed objects and governed-codec failures retain the original `arra-error/v1` code/path/envelope. Cross-field publication semantics (nonnull NEW label, invalid validity interval or violated assignment cardinality) use publication invalid_request at the governed content path; missing/new foreign references use invalid_reference; stored duplicates/corrupt rows/policies use integrity_failure. Do not turn a changed retry digest into invalid bytes: it is the operation_digest conflict classification in section2.

Persistence errors use a SEPARATE exact `{version:"arra-publication-error/v1",code,path,message}` envelope, with RFC6901 path and the following literal safe messages: invalid_request="invalid publication request"; not_found="node not found"; invalid_reference="invalid scoped reference"; integrity_failure="stored state failed integrity validation"; writer_unavailable="dataset writer unavailable"; unsupported_dataset="unsupported target dataset"; recovery_required="writer recovery required"; limit_exceeded="publication limit exceeded". Read/state/owner errors use path=""; reference/request errors use their exact request pointer. Error objects expose this via toJSON and stable code/path; no arbitrary caught exception text, credentials or dataset paths. Authentication errors remain #25's boundary, not invented in this kernel.

## 9. Required discriminating evidence

Deterministic fault-test seam: `openPublicationWriter(datasetRoot, options?)` may accept trusted operator-only `clock`, `newRevisionId`, and `onBoundary?: (boundary: PublicationBoundary) => Promise<void>` dependencies. These are not request JSON fields, environment-controlled hooks, routes, exported owner tokens, or raw storage access. The optional callback receives ONLY a closed boundary string: `before_append`, `after_revision_append`, `after_revision_readback`, or `after_head_publication`. Default is no callback. Await it at those actual sequence points, including applicable orphan-resume head publication; do not replay append boundaries when no append occurs. The fixture child signals its parent and parks in the callback; the parent owns the deadline, SIGKILL and reap. Response-emission before/after handshakes belong to the child harness AFTER the service returns, not to a fabricated service transport. A callback failure after any attempted write enters the same recovery_required/fail-stop path as other ambiguous post-write failures; it cannot permit queued writes to continue. This hook demonstrates process death at commanded SDK boundaries, not power-loss atomicity.

- Exact first-node and successive-revision round trips on fresh target19 copied fixtures; both snapshots remain authoritative, no projection table write or embedding invocation.
- Real child SIGKILL at before-append, after-revision-append, after-readback/before-head, after-node/head publication and before/after response emission (lost ACK). Parent handshake reaches the named boundary before kill; fresh owned process reconstructs, not a same-handle mock. Verify one accepted result/no duplicate operation and unchanged old rows.
- New-node orphan recovery, node-ID collision with accepted/other-orphan, changed-payload retry, accepted retry after later head, stale-base contenders, duplicate operation/node/revision corruption, missing/cross-node/cross-workspace/cyclic/digest-corrupt ancestry.
- Independent processes: writer-vs-writer and writer-vs-Python-migrator contention BEFORE connect; alias-root paths contend; lock acquisition after exact owner kill/reap; same-process second owner and concurrent request queue. Raw unwrapped writer fails.
- Cross-process reader sees complete old or complete new head chain when publication interleaves; never prepared/orphan rows. Explicit stale-handle refresh test, no reinterpretation of a cached query result as freshness.
- Actual two-workspace peers/sessions/terms/vocabularies/messages/traces/revision refs; invalid/duplicate/retired/mismatched references and policy cardinality reject before append. Historical snapshots survive rename/retirement in a separate gate-compliant migration setup.
- Physical drift rejects before writes; exact-millisecond and non-millisecond timestamp round trips; Int64 ordinal bounds; 1024 ancestry limit. Count schema/version/rows before/after rejected cases, not merely mkdir success.
- Inject all model/network dependencies as fail-if-used; no authoritative code import of embed/search/model modules. Source-text checks are bounded, not universal runtime proof.
- Existing Python/Bun/CLI suites, typecheck/build, changed-file Ruff and tracked/untracked whitespace; frozen protected active runtime/auth/codecs/schema/goldens/manifests/locks unchanged except an explicitly reviewed exact import-guard change if necessary.

## 10. Primary API references and scope

[LanceDB connect](https://lancedb.github.io/lancedb/js/functions/connect/), [ConnectionOptions](https://lancedb.github.io/lancedb/js/interfaces/ConnectionOptions/) and [Table](https://lancedb.github.io/lancedb/js/classes/Table/) document the relevant calls; installed0.38 declarations/source were checked. They do not document a multi-table transaction or independent expected-version CAS for Table.update. New Arrow write/read tests must establish actual schema-preserving microsecond/Int64 behavior.

Initial allocation is deliberately included; unknown headless adoption is not guessed. This contract does not close #26 or authorize a new runtime surface. The local lock remains a cooperative trusted-operator exclusion protocol, not protection against arbitrary same-UID code bypassing it.

## 11. Exact implementation ownership — separate dispatch required

Allowed new source: `app/server/src/publication/{errors,rows,storage,service}.ts`; `app/migrate-py/src/arra_migrate/writer_gate.py`. The Python module owns a reusable context-managed lock and an explicit local launcher that locks the supplied canonical dataset before exec of the specified owned Bun program. No package entrypoint/manifest change. The TS service module exposes `openPublicationWriter(datasetRoot)` (requires validated inherited gate and unique in-process owner) and `openPublicationReader(datasetRoot)` (only scoped read methods); neither exports raw tables or caller-mintable owner handles. Factories receive operator configuration, not user JSON scope authority.

Allowed new tests/helpers: `app/server/test/publication-{service,recovery,ownership}.test.ts`, `app/server/test/helpers/publication-fixture.ts`, `app/server/test/fixtures/publication-v1/**`, `app/migrate-py/tests/test_writer_gate.py`, `app/migrate-py/tests/export_publication_fixture.py`, `app/migrate-py/tests/fixtures/publication-v1/**`. The owned Bun fault-test child lives under test fixtures, not an active runtime worker or new public CLI.

`export_publication_fixture.py` is the ONLY new fixture creator/migration participant: it acquires writer_gate before writable connect/create, seeds independently authored rows against existing Python models/golden and refuses existing dataset replacement. Its migration-contention test proves rejection before connect. TS publication owners use the same gate. Existing target-schema fixture exporter/tests continue on their own disjoint ephemeral datasets unchanged; they are NOT claimed retroactively to participate in this lock protocol. No arbitrary external tool is prevented from bypassing a cooperative lock.

Existing file expansion allowed only if necessary: `app/migrate-py/tests/test_revision_v1.py` IsolationTests to add EXACT publication-file helper exemptions and complementary bounded no-active-import checks, preserving auth/composition boundaries and all unrelated test classes. No blanket publication/ or target_v1/ exclusion. The exact expansion is: add only publication/errors.ts, publication/rows.ts, publication/storage.ts and publication/service.ts to HELPER_REUSE_ALLOWED; retain all current auth exemptions, adapter files, floors, existing assertions and unrelated test classes. Add a complementary recursive scan of server/src OUTSIDE those exact four files plus app/cli.ts for enumerated publication-import strings, and Python src outside writer_gate.py for enumerated writer_gate imports. Assertions must prove scan selection is nonempty with existing floors, and sensitivity fixtures must be hand-written independent source in TemporaryDirectory, not generated from searched patterns or written into product source. Document these as bounded source-text checks, not module resolution or dynamic-import proof. Existing runtime/auth/codecs/schema/goldens/manifests/lockfiles, accepted fixtures and exporter remain byte-unchanged. Root owns this contract, DESIGN/status, issues and acceptance. Neo-claude owns only the named implementation/tests; no commit until leader evidence handoff.
