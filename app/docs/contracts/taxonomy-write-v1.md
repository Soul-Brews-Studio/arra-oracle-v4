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

- `createTerm`, `renameTerm`, `retireTerm` and `reparentTerm` refuse any vocabulary whose stored `term_policy` is `sealed`. That covers both reserved bootstrap vocabularies and every other sealed vocabulary, including one a caller created before this change.
- The refusal is `invalid_request`, which is this contract's existing semantic-policy refusal family (reserved vocabulary creation, retired-term mutation, last-required-term retirement). No error code is added. For `createTerm` the path is `/vocabulary_id`. For the other three it is `/term_id`, because the term's own stored vocabulary decides.
- The transports carry it unchanged: HTTP 400 with the `arra-taxonomy-error/v1` envelope, and the same envelope as an MCP tool error.
- `createVocabulary` refuses `term_policy: sealed`, required or not: `invalid_request /term_policy`. Only the operator may create a sealed vocabulary. Nobody else can add a term to one, so a caller's sealed vocabulary would stay empty for good. A required one would make every later `publishRevision` in the workspace fail its required-vocabulary check (`invalid_request /content/term_snapshot_json`), and no transport can add the term, delete the vocabulary or clear `required`. An optional one would occupy its scoped name, empty, for good. Open vocabularies are unchanged. (Found by the independent verifier as B1. The first cut of this amendment said a caller could still create an empty sealed vocabulary; that was the defect.)
- `seedReservedVocabularies` refuses to append a term to a sealed vocabulary that is already stored: `invalid_request` at that term's manifest pointer, for example `/type/terms/learning`. Without this, once a reserved term had been renamed (by the operator, or by any writer before this change), a seed naming a new id for the freed literal name appended a sixth active term to `type`, over HTTP or MCP. (Found by the verifier as B2. The first cut claimed the seed could not add a sixth type term; it could.) This narrows the resume rule above: "a matching vocabulary present with some expected terms absent" is now resumable by the operator only. The seed never produces that state itself. It stages terms before vocabularies, so an interrupted seed leaves terms without their vocabulary, and anyone may still resume that.
- The sentence "Operator creation may extend a sealed vocabulary; no ordinary-caller authorization claim" now means an operator in-process only. A writer factory (`openKnowledgeWriter`, `openContextWriter`, `openEvidenceWriter`) opened with the trusted option `taxonomyOperator: true` may create a sealed vocabulary, and may create, rename, retire and reparent terms in one, including a seed that appends a missing manifest term. This is the lifecycle described above.
- `taxonomyOperator` is configuration, like `clock` or `sourceNamespace`. It is never request data: the request grammar is unchanged, so a `taxonomyOperator` key in request bytes is `unexpected_field`.
- Absent or false means refuse, so the default fails closed. `createKnowledgeAccess` (HTTP and MCP) never sets it, and there is no CLI or other transport path. No policy action is added, and the closed action set in `authorization-v1.md` is unchanged.
- `renameTerm` now resolves the term's vocabulary. A term whose vocabulary is missing is `integrity_failure` at the root path, which is what `retireTerm` and `reparentTerm` already did.
- Unchanged:
  - `seedReservedVocabularies` still writes only the literal manifest rows and stays transport-reachable. It is still the only non-operator way to create the reserved vocabularies and their terms. A fresh seed, a replay and the resume of an interrupted seed all behave as before. Another id for a reserved name that is still occupied, even by a retired row, is still a conflict.
  - `createVocabulary` still refuses the reserved names, and still creates an open vocabulary for any `content:write` caller.
  - Publication may still assign an existing active term of a sealed vocabulary. The seal governs a vocabulary's term set, not assignment.
  - Reads are unchanged.
- A seal refusal happens before any write, so it never poisons the owner.

**Precedence.** For the four term mutators this replaces the single "Use this precedence" sentence above. `app/server/test/taxonomy-seal.test.ts` pins it:

1. Request validity. Strict parse and closed shape give `arra-error/v1`, and an operator flag in the bytes is `unexpected_field`.
2. Workspace: `invalid_reference /workspace_name`.
3. The scoped target. For `createTerm` that is its vocabulary: `invalid_reference /vocabulary_id`. For the lifecycle methods it is the term: `not_found /term_id`. The existing retired-term refusal of `renameTerm`/`reparentTerm` (`invalid_request /term_id`) keeps its place here.
4. Stored-state integrity of the target's vocabulary: `integrity_failure` at the root path.
5. Requested references and structure: the `createTerm`/`reparentTerm` parent. A non-null parent in a flat vocabulary is `invalid_request /parent_id`. Then self or cycle, then scoped ancestry: `invalid_reference`, `integrity_failure` or `limit_exceeded`.
6. **The seal**: `invalid_request /vocabulary_id` (`createTerm`) or `/term_id`.
7. Collisions and expected values: `conflict` at `/name`, `/term_id`, `/expected_name` or `/expected_parent_id`. Then `retireTerm`'s last-required-term refusal.
8. `already_satisfied`. Without the operator flag this is never reached for a sealed vocabulary. An exact replay of a seeded row is therefore refused, not reported as satisfied.
9. Persistence.

`createVocabulary`, pinned by the same file:

1. Request validity. A reserved name is `invalid_request /name` from the parser.
2. Workspace: `invalid_reference /workspace_name`.
3. **The seal**: `invalid_request /term_policy`. It depends only on the request, so it needs no stored row.
4. Stored-state integrity of the rows at the requested id and name.
5. Collisions: `conflict /vocabulary_id`, then `conflict /name`.
6. `already_satisfied`. Without the operator flag this is never reached for a sealed request, so an ordinary replay of an operator's sealed vocabulary is refused.
7. Persistence.

`seedReservedVocabularies`, pinned by the same file:

1. Request validity.
2. Workspace.
3. The whole-manifest preflight described above, row by row in manifest order: `integrity_failure` or `conflict` at the row's pointer.
4. **The seal**: the first missing term, in manifest order, whose sealed vocabulary is already stored: `invalid_request` at its pointer.
5. `already_satisfied`, or staging.

The seed is the one place a conflict outranks the seal. A seed compares a whole manifest with stored state, and a conflict says they disagree, which this contract already makes terminal. A conflict listed after the refused row still wins. Putting the seal first would also turn existing conflict answers into seal refusals. One example is `http:seed:extend`: another id for the still-occupied `note` is a conflict today, and would become a seal refusal.

The transport layers run first and are unchanged:

- route, method, encoding and size checks;
- body well-formedness and route-scope equality (`knowledge/transport.ts`);
- admission. A missing or invalid bearer gets 401. A principal without `content:write` gets 403, on HTTP and on MCP.

All of these come before any seal refusal, so an unauthorized caller never learns a vocabulary's policy.

**Tests changed.** In `taxonomy-seal.test.ts`, the caller-policy cases use a sealed `house-rules` vocabulary that the operator creates first (child mode `operator-rules`), since an ordinary caller can no longer create one. Its HTTP and MCP harness moved, unchanged, to `test/fixtures/taxonomy-v1/seal/openSealWire.ts`. Two groups exercise the operator lifecycle on reserved `type` terms: the `retirement` and `aba` modes of `taxonomy-ownership.test.ts`, and two cases in `taxonomy-service.test.ts` (changed-seed-row conflict, last-required-term retirement). They now open the writer with `taxonomyOperator: true`. Their expected values are unchanged, including `taxonomy-ownership.test.ts` "reuse-retired-name conflict /name". The `references` and `tree-boundary` modes stay ordinary owners and still pass unchanged, which pins steps 2 to 5 above.

**Still open for #27.**

- An authorized admin tier over the wire. That would be a new policy action, and R6 adds none.
- Ordinary omitted type defaulting to `note`.
- `node_revision_terms` projection after publish.
- Cleanup of datasets that already hold terms invented before this change. Those terms are now sealed like any other, so only the operator can rename or retire them. Revisions already typed with them remain valid history, because the snapshot is the authority.
- Cleanup of datasets that already hold a sealed vocabulary a caller created before this change. Only the operator can add a term to it. If it is also required, every publish in that workspace fails until the operator adds a term, or the row is removed outside the transports.
- A sixth `type` term re-seeded before this change stays in the dataset. It is sealed like the rest, and only the operator can retire it.
- The publication fixture (`migrate-py/tests/export_publication_fixture.py`) builds `type` with `term_policy: open`, not the sealed bootstrap. Tests over that fixture, such as the association suite's rename and retire of `note`, pass as ordinary writers only because of that. They do not exercise a production-shaped `type`.
- `DESIGN.md` still says "authorized vocabulary admins may extend `type`". Today that admin is the in-process operator only. Left for the docs pass (P6).

## Amendment 2026-09-26 (overnight R18 (V0 + K2 + VA fixes))

v4-overnight, v3-frame slice (Claude Opus 5.5, AI). Ruling: `docs/overnight/DECISIONS.md` R18, design `docs/overnight/V3-PARITY.md` §5 (K2) and §3 A4. The text above is not rewritten; this section adds two reads to "Results and read evidence" and changes nothing else.

**Why.** The by-name lookups existed only inside create, rename and seed (`service.lookupVocabularyByName.ts`, `service.lookupTermByName.ts`). A caller that knows a name but not the id another writer chose (the UI, the migration, a different adapter) had no read for it: `createTerm` on an occupied name answers `conflict /name` with no id, and nothing else maps a name to a row. The v3 adapter (R18) resolves `type`, `memory_horizon`, `concepts`, `legacy_type`, `project` and each concept term by name before every write, so it cannot work on a workspace seeded by anyone else without these reads.

**Change.** Two read methods on every taxonomy reader facade (and so on every writer facade, which spreads the reads in), registered in `knowledge/registry.ts` under `content:read`, `scopePath: []`, reachable as `POST /api/knowledge/:bank/<method>` and MCP `kb_<method>`:

- `lookupVocabularyByName {workspace_name, name}`
- `lookupTermByName {workspace_name, vocabulary_id, name}`

Grammar: closed objects, every key required. `workspace_name` uses the existing workspace grammar. `name` uses the create grammar exactly (nonempty valid Unicode, at most 256 UTF-8 bytes, no trim, no case fold, no NFC), so every name a writer can store can be looked up and a name that could never be stored is a governed `arra-error/v1` refusal (`missing_field`, `unexpected_field`, `invalid_type`, `invalid_value`, `limit_exceeded`), never a miss. `vocabulary_id` is a nanoid21. Term names are unique per vocabulary, not per workspace, so the term lookup needs the vocabulary id.

Result: the complete wire row, encoded exactly as `getVocabulary`/`getTerm` encode it, or `null`. The same rules as those reads apply: refresh the table, scope by workspace (another workspace's row is `null`, never an error), duplicates at a scoped name are `integrity_failure`, reads do not mutate or join the write queue. A retired term is returned with `is_active: false`, as `getTerm` would return it; whether it is usable is the caller's decision, and hiding it would make an occupied name look free. The lookup is the same scoped query create and seed already run, so a lookup and a create can never disagree about which row a name names.

**Peer binding.** Both methods assert no acting peer; `knowledge/registry.peerFields.ts` classifies them `[]`. The same edit classifies the 13 methods expose-13 registered after that table was written (`createTrace.peer_name`, `createSessionLink.created_by_peer_name`, `retireNode.peer_name`, `supersedeNode.peer_name`; the other nine assert none). Without it a grant carrying a `peers` binding was refused all 13 wholesale, and `transport-peer-fields.test.ts` failed on the integration branch.

**Tests.** `app/server/test/taxonomy-lookup-service.test.ts`: by-name hit equal to the by-id read, miss is `null`, exact names (no trim or case fold), workspace isolation, closed keys and the name grammar, and the same answer over HTTP and MCP for a `content:read`-only credential. Written before the methods existed and seen red (0 pass, 8 fail).

## Amendment 2026-09-26 (overnight R18 (K6 + K7 + V8))

v4-overnight, v3-stats slice (Claude, AI). Ruling: `docs/overnight/DECISIONS.md` R18, design `docs/overnight/V3-PARITY.md` §5 (K6, K7) and §4.3/§4.4 (V8). The text above is not rewritten; this section adds three reads to "Results and read evidence" and changes nothing else. It was rewritten in place across two verifier fix rounds before it merged anywhere, so it states the final behaviour once; the corrections are listed under "Fix rounds" below instead of as contradicting sections.

**Why.** `oracle_concepts` and the full (post-K7) shape of `oracle_stats` had no kernel to call: nothing counted how many current entries carry a term, and nothing counted nodes, chunks or taxonomy rows for a workspace. All three methods are read-only aggregates over existing columns. There is no new table and no new column.

**Change.** Three read methods on every taxonomy reader facade (and so on every writer facade, which spreads the reads in), registered in `knowledge/registry.ts` under `content:read`, `scopePath: []`, reachable as `POST /api/knowledge/:bank/<method>` and MCP `kb_<method>`:

- `listTerms {workspace_name, vocabulary_id, after_id, limit, include_inactive}`: a keyset-paginated listing of one vocabulary's terms, each row encoded exactly as `getTerm` encodes it. `getTerm` and `lookupTermByName` fetch one row only; this is the first way to enumerate a vocabulary.
- `listTermUsage {workspace_name, vocabulary_id, type_term, limit}`: for one vocabulary, how many CURRENT heads carry each term. The count comes from each accepted head revision's own `term_snapshot_json`, one point read per head (the read `listNodes`' `type_term` filter already pays). It never reads the derived `node_revision_terms` projection; see "Source of the count" below. `type_term`, when not null, is a reserved `type` term name that restricts counting to heads of that type, derived from the same snapshot by the same decoder `listNodes` uses. The response is `{rows:[{term_id,name,count}], total_unique, coverage}`. `rows` is sorted by count descending, then name ascending, and capped at `limit`. `total_unique` counts every distinct term before that cap. `name` is the head snapshot's `term_name_snapshot`. When a rename has left heads disagreeing, the first node in id order wins. `count` and `total_unique` are canonical decimal-text Int64 strings, like every other count in this contract. A null head, a head pointer that matches 0 or more than 1 revision row, or a duplicate `term_id` inside one stored snapshot (publication refuses one) is `integrity_failure`, never a quietly smaller count.
- `knowledgeStats {workspace_name}`: workspace-wide counts `{nodes_total, nodes_eligible, by_type, chunks, vocabularies, terms, last_updated_at}`. `nodes_total`, `vocabularies` and `terms` are the SDK's own native `countRows`, exact and unbounded. `by_type` (`[{term,count}]` over accepted heads, each head's type from its snapshot) and `last_updated_at` (the greatest `nodes.updated_at`) come from one bounded scan of `nodes`. `nodes_eligible` (total minus the terminal old ids in `supersede_log`) comes from a separate bounded scan of `supersede_log`. `chunks` (`[{embedding_profile,status,count}]`) comes from a bounded scan of `search_chunks_v1`.

**Workspace.** All three check the `workspaces` row right after request validity, as `listNodes`, `listPeers` and `listSessions` do. A granted bank with no row is `invalid_reference /workspace_name`, never an answer of exact-looking zeros.

**Source of the count (a stated deviation from V3-PARITY.md §5, which lists `node_revision_terms` as a K6 source).** The projection exists for a revision only after `reconcileRevisionAssociations` has run for it, and no ordinary writer runs it: not `kb_publishRevision`, not HTTP `publishRevision`, not the v4 UI. Only the migration's `deriveProjections` does. Counting projection rows therefore dropped every unreconciled head while `coverage` still said `"full"`. The verifier measured this live: after `oracle_learn {concepts:[apfs,backup]}` and a `kb_publishRevision` of a second node with the same snapshot, `oracle_concepts` answered `apfs:1, backup:1` with no warning, while the published terms give 2 and 2. `association-evidence-v1.md` §4 already rules this out ("Do not answer completeness from projection candidates"). `listTermUsage` now reads neither derived table, so no writer can make its count wrong by skipping a step, and a stale or partial projection cannot change it either. The snapshot can answer a `many`-cardinality vocabulary: `taxonomy.termSnapshot.ts` writes one entry per concept. An earlier draft of this section claimed it could not; that claim was false.

**Bounded scans disclose; they never guess.** Every scan is capped: `nodes` at 1000 (the same as `listNodes`' `MAX_SCANNED_NODES`), `supersede_log` at 2000 and `search_chunks_v1` at 5000.
- `listTermUsage` reports a truncated node scan as `coverage: "partial"`. That is the same shape R14's ngram fallback and `listNodes`' `type_term`-filtered `total` use. `coverage` has no other meaning, because the count no longer depends on any projection lag.
- `knowledgeStats` has no single aggregate to hang a flag on. Each field a truncated scan cannot answer exactly comes back `null`: `by_type` and `last_updated_at` together, `nodes_eligible`, and `chunks`. A native count is never null.

**Peer binding.** All three assert no acting peer; `knowledge/registry.peerFields.ts` classifies them `[]`.

**V8: `oracle_concepts` and `oracle_stats`.**
- `oracle_concepts` resolves the `concepts` vocabulary by name (K2 `lookupVocabularyByName`). If it is absent, the answer is an exact empty list, not an error. Otherwise the tool calls `listTermUsage`. `limit` follows v3's own `normalizeLimit`: a missing, non-integer or non-positive value (including `0`) means 50, and anything above 200 means 200.
- v3's `type:learning` is also a v4 type, so it passes through with no warning. v3's `principle`, `pattern` and `retro` are stored as `note` plus a `legacy_type` term (A5), which this filter does not read. They match nothing and carry a `semantic_change` warning.
- `oracle_stats` takes `total_documents`, `by_type`, `fts_indexed` and `last_indexed` from `knowledgeStats`, and `unique_concepts` from `listTermUsage`'s `total_unique`. `vector_status` (`empty`/`pending`/`ready`/`degraded`/`unknown`) is derived from the per-status chunk counts, never from a live LanceDB probe, because v4 IS the vector store.
- An unmeasured K7 field is `null` on the wire and named in `compat_warnings`, never a placeholder (`{}`, `0`, `"empty"`). `last_indexed` is named alongside `by_type` because they share one scan, and `fts_status` alongside `fts_indexed`.
- Both tools pass K6's honesty on. `coverage: "partial"` becomes a `partial` warning on `concepts` or `unique_concepts`.
- A counted `handoff` concept becomes a `semantic_change` warning. Every `oracle_handoff` call is a v4 node (type `note`, `concepts:handoff`), while v3 kept handoffs as inbox files it never counted. `oracle_stats` asks K6 for the full 200-row ranking so that it sees the handoff row.
- Both `mcp/legacy-v3/catalogue.ts` entries list exactly the methods they call.

**v3 write path unchanged.** The adapter's `publish()` (`mcp/legacy-v3/publish.ts`) does not call `reconcileRevisionAssociations`. The first fix round made it do so, to fill the projection K6 then read. Once K6 read snapshots nothing needed that call, and it cost one more gated write per v3 write plus a failure path of its own. The second fix round removed it, and `publish.ts` is back to the base behaviour.

**Fix rounds.**
- The first cut counted `node_revision_terms`. Its end-to-end test hid the lag by calling `kb_reconcileRevisionAssociations` by hand, which no v3 client can do. `oracle_stats` also put `{}`, `0` and `"empty"` on the wire for unmeasured fields.
- The first fix round made the v3 write path reconcile, nulled and named the unmeasured `oracle_stats` fields, and killed mutants M2, M3, M4 and M10.
- The second fix round, after the verifier's blocking finding that every non-v3 writer was still undercounted with `coverage: "full"`:
  - moved the count to head snapshots;
  - removed the v3 reconcile call;
  - added the workspace check;
  - limited the `type` warning to non-v4 types;
  - named counted handoffs;
  - killed M12, M13 and M14 (a dropped workspace scope), M16 (name-only sort), and M18 and M19 (a dropped `partial` warning).

**Tests.**
- `app/server/test/taxonomy-term-usage-scans.test.ts` (in-memory adapter): snapshot counting with zero projection rows, stale projection rows ignored, count-then-name order, `total_unique` beyond `limit`, `type_term`, integrity failures, bounded windows at 1000 and 1001, exact `knowledgeStats` counts, two workspaces with different data in every table, and `invalid_reference` for a missing workspace row.
- `taxonomy-term-usage-service.test.ts` (real fixture and wire): listing, exact seeded counts, grammar, HTTP/MCP parity, and `invalid_reference` over HTTP for a granted but unseeded bank.
- `mcp-v3-stats.test.ts` (real gate, real dataset, MCP): the verifier's repro, plus the V8 shapes.
- `mcp-v3-stats-adapter.test.ts`: `oracle_stats`/`oracle_concepts` translation of unmeasured or partial kernel answers, type warnings and handoff warnings.
- Second-round red, recorded before the fix:
  - `listTermUsage` answered `{rows:[], total_unique:"0", coverage:"full"}` for three unreconciled heads carrying apfs ×2 and backup ×1.
  - `oracle_concepts` answered `apfs:2, backup:1` after a `kb_publishRevision` whose published terms give 3 and 2.
  - The unseeded bank answered 200.

## Amendment 2026-09-26 (post-merge PROOF.md rule: every number measured, the command beside it; doc-contradicts-code is a defect)

Source: `docs/overnight/DECISIONS.md` (the PROOF.md rule), issue #22, and the proof sweep
(`docs/overnight/PROOF-SWEEP.md`). Written 2026-09-27 on `594df54`.

**Change.** The R18 (K6 + K7 + V8) amendment's "v3 write path unchanged" paragraph says the
adapter's `publish()` "does not call `reconcileRevisionAssociations`" and "is back to the base
behaviour". It was true on the branch that wrote it (`dd478f8`). It is not literally true on
`594df54`: the parallel V3 trace-tools slice (`61dd298`, not an ancestor of `dd478f8`; the two
met at the merge) gave `publish()` an opt-in `reconcile` option (`mcp/legacy-v3/publish.ts:110-118`),
and `oracle_trace_distill` sets it (`tools/oracle_trace_distill.ts:88`), as `trace-v1.md`'s K5 text
says. What the paragraph
means still holds: `reconcile` is set by no other v3 tool, so an ordinary v3 write
(`oracle_learn`, `oracle_handoff`, ...) does not reconcile, and K6 reads head snapshots, which
never needed the call. The original paragraph is left as written, because frozen contracts are not
rewritten; this amendment is the correction.

**Why.** A contract sentence that the code contradicts is a defect under the PROOF.md rule, even
when the conclusion drawn from it survives.

**Command.** `rg -n 'reconcile: true|input.reconcile' app/server/src/mcp/legacy-v3` prints
exactly `publish.ts:110` and `tools/oracle_trace_distill.ts:88`.

## Amendment 2026-09-26 (post-merge Nat 2026-09-28 NAT-DECISIONS D5a: the legacy free-text MCP remember tool goes through taxonomy validation now)

Source: `docs/overnight/DECISIONS.md` NAT-DECISIONS D5a, and AC-MATRIX conflict C1
(slice 9: the legacy MCP `remember` tool wrote the spike `memories` table with no
taxonomy validation and described itself as "planned, not implemented").

**Change.** The legacy MCP `remember` tool (`app/server/src/mcp/index.ts`'s `remember`
case; schema in `app/server/src/mcp/tools.ts`) now routes its `type` field through the
same sealed `type` vocabulary `kb_publishRevision`'s `validateTermReferences.ts`
enforces, via the new `app/server/src/mcp/remember.validateType.ts`. Omitted `type`
defaults to `note`, exactly like the reserved seed. An unknown or retired term, or a
missing `type` vocabulary, is refused with the SAME closed `arra-taxonomy-error/v1`
envelope (`invalid_reference`, path `/type`) `kb_publishRevision` already gives for the
equivalent cause -- not a bespoke error shape. A valid, active term is accepted and the
write proceeds byte-for-byte as before (`sync_state`/`embedded` unchanged).

This is validation of the `type` VALUE only: it does not give `remember` a
`node_revisions`/`term_snapshot_json` row, does not write to `node_revision_terms`, and
does not let `remember` create, rename, retire or reparent a term -- all taxonomy
MUTATION stays exactly where this contract already put it (§ above). A `remember` call
against a deployment with no `KnowledgeAccess` configured at all now fails closed
(`invalid_request`, path `/type`) rather than silently accepting free text -- D5a is
"validate it now", not "validate it when convenient".

Precedence: the existing `#87`/R3 peer-binding refusal (`forbidden`, an asserted
`peer_name` outside the admitting grant's binding) still fires BEFORE the taxonomy
check -- `mcp/index.ts`'s `remember` case checks `isBoundAuthor` first, mirroring the
order `ops.insert` already enforced, so this change does not reorder an existing
refusal.

**Why.** The old free-text `type` let a caller invent or resurrect any string as a
memory's type outside the sealed vocabulary the rest of the system trusts, and the
tool's own description claimed the opposite of what AC-MATRIX's C1 required.

**Tests.** `app/server/test/mcp-remember-taxonomy.test.ts` (unit, fake `KnowledgeAccess`):
unknown type refused, retired term refused, missing `type` vocabulary refused, valid
term accepted unchanged, omitted type defaults to `note`, a Thai term name accepted when
it resolves as active, and no `KnowledgeAccess` configured fails closed. Peer-binding
precedence and byte-for-byte valid-write behavior are covered by the existing
`app/server/test/auth-legacy-peer-binding.test.ts` and `app/server/test/mcp-correctness.test.ts`
(both updated to wire a fake taxonomy-resolving `KnowledgeAccess`, since their datasets
predate this change and carry no `vocabularies`/`terms` tables of their own).

### Fix-round amendment 2026-09-28 (Opus verification on the first D5a pass)

The paragraph above overstated one case and was silent on two others. Corrected here,
not rewritten in place, so the record of what the first pass actually claimed stays
intact.

**Correction 1 -- what "no `KnowledgeAccess` configured" actually means.** The ruling
lives at `docs/overnight/NAT-DECISIONS.md:29` (D5, option a), not
`docs/overnight/DECISIONS.md` -- there is no D5/D5a entry there; the source line in
`Amendment 2026-09-26` above is wrong and is corrected by this note, not edited in place.

The prior paragraph's claim that an unconfigured deployment "fails closed
(`invalid_request`, path `/type`)" is true ONLY when `knowledgeAccess` itself is `null`
(no MCP knowledge wiring at all -- a wiring gap, effectively test-only). It is NOT true
of the documented, production-real case: `ARRA_KNOWLEDGE_DATASET_ROOT` unset with a
non-null `KnowledgeAccess` (`composition.ts`'s `composeKnowledgeAccess`: "an existing
deployment that has not adopted the ... dataset yet keeps starting up exactly as
before"). In that shape `getBundle` throws the kernel's own
`arra-publication-error/v1 unsupported_dataset`, which `remember.validateType.ts` now
catches and treats as "nothing to validate against" -- `remember` accepts ANY `type`
unchanged, exactly as it did before D5a, rather than refusing every call. Failing every
call in that shape was never asked for by D5a and was not a choice this contract
recorded; it was a regression an independent verifier caught by deleting one test-only
override line and re-running `test/mcp-correctness.test.ts` against real `buildApp`
wiring.

**Correction 2 -- HTTP parity.** The prior text said nothing about `POST /api/memories`.
That route is audited as MCP `remember` (`app/server/src/app.ts`'s handler comment,
#31 legacy-audit) and, as of this fix round, goes through the SAME
`remember.validateType.ts` call, wired as `StoreDependencies.validateType` in
`composeService` (`app/server/src/composition.ts`) and invoked from
`auth/service.ts`'s `insertMemory`, using the SAME `KnowledgeAccess` `buildApp` composes
for MCP -- not a second one. `buildApp` (`app/server/src/index.ts`) now composes
`KnowledgeAccess` BEFORE the service, so the service can be given it. An invented type
over HTTP now gets the identical `arra-taxonomy-error/v1 invalid_reference` envelope,
propagated through `knowledgeErrorResponse` in `app.ts` rather than falling through to a
generic `policy_unavailable` 503. Before this fix round, `POST /api/memories` accepted
any free-text `type`, which broke #31 AC-MATRIX row 111 ("equivalent HTTP/CLI/MCP
fixtures enforce the same invariants").

**Correction 3 -- test adequacy.** The first pass's new unit tests only exercised
`validateType` in isolation with a fake `KnowledgeAccess`; nothing dispatched `remember`
with an invalid type through real wiring. `app/server/test/remember-taxonomy-parity.test.ts`
now does, with a real `buildApp`, a real fixture-seeded taxonomy dataset
(`test/helpers/publication-fixture.ts`), and a real legacy `memories` table: it proves
(a) an unset `ARRA_KNOWLEDGE_DATASET_ROOT` still lets any `type` through on MCP, (b) a
configured dataset refuses an invented type identically on MCP and HTTP, and (c) a
seeded active type still succeeds on both, golden-shape unchanged (HTTP:
`{id, embedded}`).

**Source correction.** The Nat ruling cited by the ORIGINAL Amendment 2026-09-26 above
as "`docs/overnight/DECISIONS.md` NAT-DECISIONS D5a" is `docs/overnight/NAT-DECISIONS.md:29`
(D5 option a); this note is the correction of record.

## Amendment 2026-09-26 (post-merge Nat 2026-09-28 NAT-DECISIONS D5a (R26): the legacy free-text MCP remember tool goes through taxonomy validation now)

### Fix-round amendment, round 3 (Opus verification REFUTE on round 2)

The round-2 fix-round amendment (Correction 1 above) said the bypass fires for "the
documented, production-real case: `ARRA_KNOWLEDGE_DATASET_ROOT` unset". That was true of
the intent but not of the implementation: `remember.validateType.ts` decided the bypass
by CATCHING the error CODE `getBundle` throws (`unsupported_dataset`), and that same
code is the kernel's one generic envelope for roughly fifteen distinct storage failures
in `app/server/src/publication/storage.ts` -- a configured root that does not exist, is
not a directory, is missing a table, or has a schema/field-type/nullability mismatch all
throw the identical `arra-publication-error/v1 unsupported_dataset` shape. Catching by
code alone therefore bypassed taxonomy validation on ALL of those broken-but-configured
cases too, not only the documented root-unset one -- an operator who set
`ARRA_KNOWLEDGE_DATASET_ROOT` and then had the path go missing, get moved, or never get
migrated silently got pre-D5a free-text behaviour on both MCP and HTTP, exactly the gap
D5a exists to close.

**Fix.** `remember.validateType.ts` now decides the bypass from CONFIGURATION, not from
the error code: `isDatasetConfigured(knowledgeAccess)`
(`app/server/src/knowledge/transport.isDatasetConfigured.ts`), backed by the
`KnowledgeAccess.datasetConfigured` flag `composeKnowledgeAccess` sets to `false` ONLY
when `ARRA_KNOWLEDGE_DATASET_ROOT` itself is unset (`transport.ts`'s
`createKnowledgeAccess`). A `getBundle` failure is now bypassed (any `type` accepted,
pre-D5a behaviour) ONLY when the access reports `datasetConfigured === false`. A
`getBundle` failure on an access that reports `datasetConfigured === true`, or does not
report the flag at all (treated as configured, matching `isDatasetConfigured`'s own
rule for bare test fakes), now RE-THROWS and fails the `remember` call closed -- a
configured-but-missing/unreadable/wrong-schema root refuses the write, it does not
silently accept an unvalidated type.

**Tests.** `app/server/test/mcp-remember-taxonomy.test.ts` adds: a configured-but-broken
access (`datasetConfigured: true`, `getBundle` throwing `unsupported_dataset`) must
reject, not resolve; an access with no `datasetConfigured` flag at all throwing the same
code must also reject; the existing unset-root bypass test is updated to set
`datasetConfigured: false` explicitly, matching what `composeKnowledgeAccess` actually
sets. `app/server/test/remember-taxonomy-parity.test.ts` adds a real-`buildApp`
integration test with `ARRA_KNOWLEDGE_DATASET_ROOT` pointed at a nonexistent directory
(the exact live-probe shape the round-2 verifier used) and asserts MCP `remember`
refuses an invented type rather than succeeding; the unset-root bypass test now also
asserts the returned id is a real string, not merely `isError !== true`.

**What is still open, stated exactly.** Workspaces with a configured, working dataset
but no seeded `type` vocabulary (a workspace created after migration that never ran the
v3 adapter's `taxonomy.ensureReservedVocabularies.ts` self-seed) refuse EVERY `remember`
call, including one that omits `type` (default `note`). This is intended under the
current contract (an unresolvable vocabulary is `invalid_reference`, not a bypass) but
is an operational risk this amendment does not resolve -- it needs a Nat call on
seed-on-first-use, tracked outside this contract. `docs/overnight/AC-MATRIX.md` rows 47
and 108 remain stale from the original pass; deferred, not fixed here.

Source: `docs/overnight/DECISIONS.md` NAT-DECISIONS D5a (R26); round-3 verifier findings
in `.tmp/round3-findings-remember.txt` (scratch, not committed).

## Amendment 2026-09-26 (post-merge Nat style: one exported function per file, named after the file (origin, Nat 2026-09-12: '1 file should not too long can we split to function per file? like <= 600?'); ratchet app/server/test/one-function-per-file.test.ts)

The dataset-root checks this contract places "in
`app/server/src/publication/storage.ts`" now live in
`app/server/src/publication/storage.assertLocalDatasetRoot.ts` and
`app/server/src/publication/storage.realpathOrFail.ts`. `storage.ts` re-exports both
unchanged; no behaviour change.
