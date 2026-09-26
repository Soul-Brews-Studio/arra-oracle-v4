# Local taxonomy write v1 — frozen implementation contract

v4-codex — AI. 2026-09-21. This is the normative internal target-copy slice contract for #27. The bounded ownership and recovery reviews have been resolved in this text. It becomes implementation authority only with the separate exact-path dispatch and matching SHA; planning notes and the older issue baseline are not additional authority.
Base prerequisite: 4226126385a89e5136a8bda1490a0f43241acc9e. Keep accepted #26 behavior except the explicitly added composition surface below.

## Request grammar

All methods receive Uint8Array strict JSON using existing parseStrictBytes(maxBytes=1048576,maxDepth=64). Every object below is closed; every listed key is required; nullable means explicit null, not omission. No alternate plain-object entrypoint. Existing strict parser/shape failures retain arra-error/v1 diagnostics. Workspace uses existing nonblank Unicode/256-byte grammar. IDs use existing nanoid21 grammar. Names are nonempty valid Unicode, at most 256 UTF-8 bytes, with no trim/case/normalization. Display labels are nonempty valid Unicode. Nullable descriptions are valid Unicode strings or null. Request byte cap supplies their total bound. Arbitrary metadata/weight is not writable in this first interface; physical metadata defaults null and weight defaults exact zero.

getVocabulary: {workspace_name,vocabulary_id}
getTerm: {workspace_name,term_id}

createVocabulary: {workspace_name,vocabulary_id,name,label,description,kind,term_policy,cardinality,required,hierarchy}
kind=tags|categories; term_policy=open|sealed; cardinality=one|many; required is Boolean; hierarchy=flat|tree. Reserved names type and memory_horizon are rejected here; only bootstrap creates them.

createTerm: {workspace_name,term_id,vocabulary_id,name,description,parent_id}
parent_id is nullable ID. Always resolves a unique existing workspace and vocabulary; a nonnull parent must be active, scoped to that vocabulary, and structurally valid. Operator creation may extend a sealed vocabulary; no ordinary-caller authorization claim.

renameTerm: {workspace_name,term_id,expected_name,name}
Both names use the name grammar. Retired terms cannot be renamed. Keep every other field byte-equivalent except the intended name. Name collisions include retired rows.

retireTerm: {workspace_name,term_id}
No reactivation. Already inactive returns already_satisfied. Refuse retiring the last active term in a required vocabulary. Existing children are not reparented or retired; a retired parent may remain in historical tree structure, but cannot be chosen as a NEW parent. Publication's existing assignment validator is not widened to reject an active child merely because its ancestor was retired.

reparentTerm: {workspace_name,term_id,expected_parent_id,parent_id}
Both parents nullable IDs. The term must be active and belong to a tree vocabulary. Desired parent active in the same workspace/vocabulary. Walk desired-parent ancestry to null with scoped unique lookups, detecting self/cycles and malformed ancestry. Maximum 1024 visited rows, equality accepted; stop cumulatively and fail limit_exceeded on row1025. No unsafe shortcut because desired equals current: validate stored/requested structure before already_satisfied. Flat vocabulary accepts only null desired parent and null existing parent; malformed nonnull stored parent is integrity_failure, not repaired by this operation.

## Bootstrap request and literal rows

seedReservedVocabularies: {workspace_name,type,memory_horizon}
type: {vocabulary_id,terms:{note,conclusion,learning,discussion,correction}}
memory_horizon: {vocabulary_id,terms:{short_term,long_term}}
Every terms value is a caller-stable term ID. All nine IDs must be distinct within the supplied workspace. No caller-supplied labels/policies/timestamps or bypass flags.

Physical Vocabulary rows: requested IDs and workspace; names type/memory_horizon; labels Type/Memory horizon respectively; description=null; kind=categories; term_policy=sealed; cardinality=one; required=true for type and false for memory_horizon; hierarchy=flat; h_metadata/internal_metadata=null; created_at from the trusted clock when a missing row is allocated.
Physical Term rows: requested IDs/workspace/vocabulary; literal keys as names; description=null,parent_id=null,weight=0,is_active=true,h_metadata=null; created_at trusted exact-millisecond time when missing row allocated. No term label exists.

Retain existing allocation times after validating raw microsecond alignment. Compare every other field to literal seed state. A renamed/retired/otherwise changed seed row conflicts rather than being repaired. Reserved terms may undergo the explicitly allowed lifecycle operations, but subsequent bootstrap conflict is terminal through these eight methods: reconciliation is outside this slice and requires a later reviewed operator operation. No claim that re-running seed repairs administration. A missing/retired/renamed note cannot silently generate a substitute default; a future default-to-note adapter must fail closed until reconciled. Exactly matching state is already-satisfied without proving who created it. An open-policy publication fixture conflicts with this sealed bootstrap; leave the accepted fixture unchanged.

Preflight the entire request and all scoped ID/name lookups before mutation. A unique row at the manifest scoped ID is the EXPECTED row, not a collision merely because it exists: compare its complete literal seed state as above. A different ID occupying the requested scoped name, a different name occupying the requested scoped ID, or any other mismatching expected field is conflict. In particular a staged term with vocabulary_id different from the supplied manifest vocabulary ID conflicts, never transfers/adopts it. Multiple rows at an expected unique scoped identity/name are integrity_failure rather than an arbitrary winner.

Resume may complete ANY subset of the nine manifest rows, provided every present expected row matches exactly (retaining its validated original created_at) and no conflicting scoped identity/name exists. This explicitly includes terms present with their vocabulary absent, and a matching vocabulary present with some expected terms absent. Neither state by itself is corruption or completion. Additional non-seed terms do not become seed rows and are not overwritten; ordinary scoped ID/name uniqueness checks still apply.

Stage missing terms in the literal order above (type terms then horizon terms), refreshing and verifying each append; only then append missing vocabularies in type/horizon order, verifying each. Skip already matching rows without rewriting or resampling their clocks. Only this private seed stage permits absent vocabulary rows. No duplicate creation, deletion, rollback or cleanup of unexplained rows. SDK write ambiguity poisons owner; fresh owner reclassifies supplied seed request. Partial state never claims a transaction.

## Results and read evidence

Wire rows have exactly target_v1 Vocabulary/Term fields in physical order. JSON metadata remains stored string/null; timestamps exact UTC milliseconds from raw microseconds, reject remainder before Number/Date conversion. Weight is a finite number; preserve existing exact stored value on read, but this slice only creates zero. NaN/nonfinite or malformed enum/Boolean/identity values fail integrity_failure.

getVocabulary/getTerm return a complete row or null, not a list or synthetic bootstrap status. They refresh the relevant table, distinguish absent/unique/duplicate and retain staged-term visibility even if vocabulary is absent. Returning a term does not certify assignability. Reads do not mutate, join the write queue or fail merely because the owner is poisoned. Released-owner reads fail recovery_required; a fresh gateless reader can inspect afterward.

createVocabulary/createTerm return {outcome:"created"|"already_satisfied",row}. Same scoped ID and same requested physical state (excluding original retained created_at) is already_satisfied; mismatched content or another ID occupying name conflicts. Existing allocation timestamps never refresh on a retry.
renameTerm/retireTerm/reparentTerm return {outcome:"updated"|"already_satisfied",row}. Validate all references/policy even for already-satisfied requests. For rename/reparent compare desired first, then expected; otherwise conflict. This is expected-VALUE concurrency, not a version journal: stale A->B can reapply after B->A; test and document that hazard. No exactly-once/ABA/causality promise.
seed returns {outcome:"created"|"already_satisfied",vocabularies,terms}: arrays in the literal order above, full wire rows. created means this call appended at least one row; already_satisfied means none. A resumed seed may therefore return created without proving it created every returned row. All rows freshly read back before success.

## Errors, precedence and shared owner

A separate exact {version:"arra-taxonomy-error/v1",code,path,message}, stable runtime code/path and toJSON. Codes/messages:
invalid_request="invalid taxonomy request"; not_found="taxonomy row not found"; invalid_reference="invalid scoped reference"; conflict="taxonomy state conflict"; integrity_failure="stored state failed integrity validation"; writer_unavailable="dataset writer unavailable"; unsupported_dataset="unsupported target dataset"; recovery_required="writer recovery required"; limit_exceeded="taxonomy limit exceeded".

Strict parse/closed shape errors retain existing codec envelope. Semantic errors use taxonomy envelope. Global stored-state/owner/limit errors use root path. Missing scoped target term for mutation is not_found at /term_id. Missing or cross-workspace foreign vocabulary, parent or workspace is invalid_reference at its corresponding input pointer. Duplicate scoped identity/name on any read or preflight is integrity_failure, never first-match selection; ID/name collision uses requested ID or name field respectively. Bootstrap collisions use their manifest ID pointer. Expected-value mismatch is conflict at /expected_name or /expected_parent_id. Name collision uses /name; ID collision uses the requested ID pointer. Unlike publication, taxonomy conflicts are THROWN safe errors, not returned outcome objects. Semantic policy refusals (reserved vocabulary creation, retired-term mutation, last-required-term retirement, self/cyclic requested parent or nonnull desired parent for flat vocabulary) are invalid_request at /name, /term_id or /parent_id respectively; corrupt existing ancestry is integrity_failure at root. Use this precedence: request validity, workspace, scoped target identity, stored-state integrity, requested foreign refs/policy, expected-value collision, persistence. No caught SDK path or arbitrary exception text leaks.

openKnowledgeWriter returns exactly {publication,taxonomy,close}; nested publication three existing methods, taxonomy these eight methods. openKnowledgeReader returns {publication,taxonomy}, with exactly two read methods on each facade. Existing publication factories/surfaces stay unchanged. Composite writer requires the existing newRevisionId dependency because it offers publication; taxonomy never calls it. All mutators share the module-private owner/queue/attempted-write/poison mechanism; read methods remain unqueued. close is the #46 one-shot promise.

Any error after attempted taxonomy persistence poisons the SAME owner for later publication and taxonomy writes. Preserve deliberately raised safe contract errors; normalize unknown persistence exceptions to recovery_required. Guarded updates require one affected row and complete readback. Before-write semantic failures leave owner usable. Mutation tests must distinguish both directions of shared poison and queue ordering.

Trusted fault seam onTaxonomyBoundary receives only one of before_write/after_term_write/after_vocabulary_write/after_update/after_readback. Freeze firing order PER MUTATED ROW: await before_write immediately before the attempted SDK append/update; after successful SDK return await exactly one corresponding after_term_write, after_vocabulary_write or after_update; then refresh and verify that row, and await after_readback once. The attempted-write flag is set immediately before calling the SDK, not before the before_write hook. If an earlier row was already attempted, a later before_write hook failure still poisons the operation. A failed SDK call or failed verification does not emit later success boundaries.

Fresh seed produces seven ordered [before_write,after_term_write,after_readback] triples followed by two [before_write,after_vocabulary_write,after_readback] triples, in literal manifest staging order. Resume emits triples only for missing rows, in that same filtered order. Matching skipped rows, ordinary reads, already-satisfied requests and the final all-row verification emit NO mutation boundaries. The final all-row verification remains mandatory and covered by the operation-wide post-write guard; it does not duplicate after_readback notifications.

No request-controlled hook, raw adapter or hidden admin token. Callback after attempted persistence participates in fail-stop. Children count occurrences to park at commanded boundaries; tests must assert the complete successful fresh-seed trace (9 before_write,7 after_term_write,2 after_vocabulary_write,9 after_readback) AND inspect persisted scoped identities at each crash prefix against an independently authored expected order. Counts alone cannot prove which row was written. Resume tests assert skipped-row absence from the trace and the expected remaining row identities. A thrown hook is not proof of real SDK failure; test both separately.

## Not in this dispatch

No schema edits, route/CLI/MCP activation, policy-v1 expansion, ordinary-user admin grant, default-to-note rewrite inside publication, derived association writes, live datasets, network/model calls or deployment. These are explicit remaining #27/#25 integration tasks, not achieved by this kernel. The exact ownership and validation gates below apply; preserve the frozen #26 tests and exporter.


## Scope, ownership and evidence — explicit publication-contract extension

This contract explicitly extends revision-publication-v1.md section11 for the paths and public factories named here. It does NOT change its publication request grammar, results, ancestry, reference validation, snapshots, errors, bounds, cooperative operator TCB or gate prerequisites. Supported evidence remains local Darwin/POSIX with Python3.12.13/Bun1.3.14 and the installed pinned dependencies. No Linux/NFS/R2/power-loss/multiwriter guarantee is added.

One module-private owner constructor in publication/service.ts owns canonical-root registry acquisition, connection/adapter, serial write queue, attempted-write tracking, poison, released state and one-shot close. No exported transaction callback, adapter loan, owner token or constructor accepting caller-asserted authority. Both writer factories share it. Cross-factory/alias opens contend. The existing publication writer returns exactly its four keys; nested publication returns exactly its three data methods; taxonomy has no close. The knowledge bundle alone closes its owner. Reads remain off the write queue, use fresh table reads, and are usable after poisoning but not after release. Publication failures poison later taxonomy writes and vice versa.

Runtime exports of service.ts: existing PublicationError, openPublicationReader, openPublicationWriter plus openKnowledgeReader, openKnowledgeWriter. No other runtime exports. New publication/taxonomy.ts may export only pure parsing/validation/encoding/error helpers and types: it must neither import the storage SDK nor acquire, retain or return an owner, adapter, connection or table. Taxonomy persistence stays private in service.ts. Reuse strict parser and raw Arrow helpers, not copied parsers or Date fallback. Existing protected codecs remain byte-identical.

Root owns this contract, DESIGN/status, issue bodies, acceptance, integration and commits. Neo-claude owns edits to app/server/src/publication/service.ts; new app/server/src/publication/taxonomy.ts; new app/server/test/taxonomy-service.test.ts; new app/server/test/helpers/taxonomy-fixture.ts; new app/server/test/fixtures/taxonomy-v1/core/**. Only additional tracked edit allowed is app/migrate-py/tests/test_revision_v1.py IsolationTests: add exact taxonomy.ts helper-reuse exemption and matching bounded no-active-import pattern/sensitivity fixture, preserving all existing exemptions, floors, adapter boundaries and unrelated classes. Never exempt a directory.

Fixture lane owns new app/migrate-py/tests/export_taxonomy_fixture.py and app/migrate-py/tests/fixtures/taxonomy-v1/** only. Ownership lane owns new app/server/test/taxonomy-ownership.test.ts and app/server/test/fixtures/taxonomy-v1/ownership/** only. Recovery lane owns new app/server/test/taxonomy-recovery.test.ts and app/server/test/fixtures/taxonomy-v1/recovery/** only. Workers do not edit each other's files or overwrite main source from older snapshots. No source extraction into another owner module is authorized.

Bare fixture interface: create_taxonomy_fixture(dataset_root: str, *, workspaces: list[str]) -> dict, keyed by workspace name to {workspace_id: nanoid21}. It validates all input first, acquires existing writer_gate BEFORE writable connect, refuses any existing target table without replacement, creates exactly19 tables from existing Python models/golden, and seeds only the requested workspace rows using independently authored deterministic IDs and pinned timestamps. All other18 tables remain empty. Paginate list_tables to exhaustion; no deprecated ten-table default. No existing fixture/schema/golden edits. CLI: export_taxonomy_fixture.py ROOT WORKSPACE... emits one JSON line of that mapping. Independently prove contention-before-connect with a positive sentinel control, existing-target refusal unchanged, complete schema match, deterministic scoped IDs and empty taxonomy tables under warnings-as-errors and changed-file Ruff.

Shared TS helper may export createTaxonomyFixture(workspaces) returning {datasetRoot,workspaces,cleanup} using that exporter and the existing bounded runOwnedChild helper. It must honor ARRA_CONTRACT_PYTHON and worktree PYTHONPATH. Existing publication helper is imported unchanged, not edited. Neo publishes any additional test-builder signatures before other lanes consume them; absence of convenience builders never permits schema/codec duplication as an oracle.

Every test child uses a parent-enforced deadline, exact owned-PID kill/reap and owned scratch cleanup. Source and fixtures access only disposable local copies. No network/model calls, package changes, live/existing dataset writes, credential provisioning or new active imports. Publication facade reads, errors and all frozen #26 tests stay byte-identical. Existing full suites are regression gates, not evidence that untested taxonomy behavior works.

Required independent evidence: fresh and partial seed replay/lost ACK with every persisted identity prefix and literal hook trace; expected-row vs collision and duplicate distinction; changed/retired seed state conflict without reset; exact physical rows/timestamps; same-workspace/vocabulary references and tree cycle/1024 boundary; guarded rename/reparent expected-value mismatch and documented ABA example; retired-name occupancy and last-required-term refusal; history unchanged after rename/retirement; cross-factory owner exclusion/alias identity; taxonomy+publication serial ordering, shared poison in BOTH directions and one-shot close; reads available while write is parked/poisoned and refused after release; no raw exported capability. Use actual persisted states, not all-allow mocks. At least one real SDK mutation failure followed by filesystem repair and a refused second mutation distinguishes fail-stop from a still-broken fixture. Thrown hooks are additional tests, not substitutes.

Gates at stable freeze: targeted taxonomy suites with no skips, old publication suites byte-unchanged, full Bun including CLI/nested tests with discovery counts recorded, Python discovery plus explicit new fixture suite with ResourceWarning-as-error, typecheck/build, changed-file Ruff, tracked/untracked whitespace, exact protected-path comparison and before/after hashes. Evidence is SDK-committed/read-back state and owned process death, not power-loss proof.

No commit/push/PR/merge is authorized by this document. Those require a bounded acceptance/packaging dispatch. Parent #27 remains open until the named later admin/default/projection integration criteria are delivered; #25/#26 deployment and other remaining parent criteria are not silently closed.

## Amendment 2026-09-26 (overnight R6)

v4-overnight, sealed-vocab slice (Claude Opus 5.5, AI). Ruling: `docs/overnight/DECISIONS.md` R6, for #27 reopened ("a sealed vocabulary is not sealed"). The text above is not rewritten. Where it conflicts with this section, this section governs. The SHA256 quoted in the taxonomy test headers is the SHA of the text above this section.

**Why.** #31 put every taxonomy mutator on the HTTP and MCP transports under plain `content:write`. This contract had assumed operator-only callers: its "Not in this dispatch" section excludes route, CLI and MCP activation and any ordinary-user admin grant, and `authorization-v1.md` §2 says ordinary content write must not silently become policy administration. The result was measured live: a content writer created `invented_type` inside the sealed `type` vocabulary, then renamed and retired reserved terms. #27 AC1, "unauthorized term invention is rejected", was false.

**Change.**

- `createTerm`, `renameTerm`, `retireTerm` and `reparentTerm` refuse any vocabulary whose stored `term_policy` is `sealed`. That covers both reserved bootstrap vocabularies and any caller-created sealed vocabulary.
- The refusal is `invalid_request`, which is this contract's existing semantic-policy refusal family (reserved vocabulary creation, retired-term mutation, last-required-term retirement). No error code is added. For `createTerm` the path is `/vocabulary_id`. For the other three it is `/term_id`, because the term's own stored vocabulary decides.
- The transports carry it unchanged: HTTP 400 with the `arra-taxonomy-error/v1` envelope, and the same envelope as an MCP tool error.
- The sentence "Operator creation may extend a sealed vocabulary; no ordinary-caller authorization claim" now means an operator in-process only. A writer factory (`openKnowledgeWriter`, `openContextWriter`, `openEvidenceWriter`) opened with the trusted option `taxonomyOperator: true` may create, rename, retire and reparent terms in a sealed vocabulary. This is the lifecycle described above.
- `taxonomyOperator` is configuration, like `clock` or `sourceNamespace`. It is never request data: the request grammar is unchanged, so a `taxonomyOperator` key in request bytes is `unexpected_field`.
- Absent or false means refuse, so the default fails closed. `createKnowledgeAccess` (HTTP and MCP) never sets it, and there is no CLI or other transport path. No policy action is added, and the closed action set in `authorization-v1.md` is unchanged.
- `renameTerm` now resolves the term's vocabulary. A term whose vocabulary is missing is `integrity_failure` at the root path, which is what `retireTerm` and `reparentTerm` already did.
- Unchanged:
  - `seedReservedVocabularies` still writes only the literal manifest rows. Any other id for a reserved name is still a conflict, so the seed cannot add a sixth type term. It stays the only non-operator way to create reserved terms, and it stays transport-reachable.
  - `createVocabulary` is unchanged. It still refuses the reserved names, and a caller may still create a new, empty sealed vocabulary. Only the operator can then add terms to it.
  - Publication may still assign an existing active term of a sealed vocabulary. The seal governs a vocabulary's term set, not assignment.
  - Reads are unchanged.
- A seal refusal happens before any write, so it never poisons the owner.

**Precedence.** This replaces the single "Use this precedence" sentence above for these four methods. `app/server/test/taxonomy-seal.test.ts` pins it:

1. Request validity. Strict parse and closed shape give `arra-error/v1`, and an operator flag in the bytes is `unexpected_field`.
2. Workspace: `invalid_reference /workspace_name`.
3. The scoped target. For `createTerm` that is its vocabulary: `invalid_reference /vocabulary_id`. For the lifecycle methods it is the term: `not_found /term_id`. The existing retired-term refusal of `renameTerm`/`reparentTerm` (`invalid_request /term_id`) keeps its place here.
4. Stored-state integrity of the target's vocabulary: `integrity_failure` at the root path.
5. Requested references and structure: the `createTerm`/`reparentTerm` parent. A non-null parent in a flat vocabulary is `invalid_request /parent_id`. Then self or cycle, then scoped ancestry: `invalid_reference`, `integrity_failure` or `limit_exceeded`.
6. **The seal**: `invalid_request /vocabulary_id` (`createTerm`) or `/term_id`.
7. Collisions and expected values: `conflict` at `/name`, `/term_id`, `/expected_name` or `/expected_parent_id`. Then `retireTerm`'s last-required-term refusal.
8. `already_satisfied`. Without the operator flag this is never reached for a sealed vocabulary. An exact replay of a seeded row is therefore refused, not reported as satisfied.
9. Persistence.

The transport layers run first and are unchanged:

- route, method, encoding and size checks;
- body well-formedness and route-scope equality (`knowledge/transport.ts`);
- admission. A missing or invalid bearer gets 401. A principal without `content:write` gets 403, on HTTP and on MCP.

All of these come before any seal refusal, so an unauthorized caller never learns a vocabulary's policy.

**Tests changed.** Two groups exercise the operator lifecycle on reserved `type` terms: the `retirement` and `aba` modes of `taxonomy-ownership.test.ts`, and two cases in `taxonomy-service.test.ts` (changed-seed-row conflict, last-required-term retirement). They now open the writer with `taxonomyOperator: true`. Their expected values are unchanged, including `taxonomy-ownership.test.ts` "reuse-retired-name conflict /name". The `references` and `tree-boundary` modes stay ordinary owners and still pass unchanged, which pins steps 2 to 5 above.

**Still open for #27.**

- An authorized admin tier over the wire. That would be a new policy action, and R6 adds none.
- Ordinary omitted type defaulting to `note`.
- `node_revision_terms` projection after publish.
- Cleanup of datasets that already hold terms invented before this change. Those terms are now sealed like any other, so only the operator can rename or retire them. Revisions already typed with them remain valid history, because the snapshot is the authority.
