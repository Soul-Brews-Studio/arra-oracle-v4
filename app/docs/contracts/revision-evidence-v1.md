# Revision and evidence byte contract — candidate v1

**Version:** `v26.9.20-alpha.1824`
**Date:** 2026-09-20 18:24 GMT+7
**Status:** approved bounded implementation contract after independent five-finding review and repair; not implemented/activated by this document. Review approval is design-only, not #23 completion.

Owner: v4-codex (design/acceptance). Implementer: neo-claude. Follows [target-v1 decisions](target-v1-decisions.md) and [DESIGN sections 6–8](../../../DESIGN.md). The accepted physical baseline is local commit `861809475895ecaf696fc8e2de435fbcd181ce62`, 19 tables / 228 fields; active15 and runtime remain separate.

## 1. Scope and single byte authority

```text
                            PHYSICAL SCHEMA AUTHORITY
                     Python target_v1 LanceModel -> Arrow
                                       |
                           no schema change in this slice

APPLICATION BYTE AUTHORITY                          OFFLINE ADAPTER
TS/Bun pure contracts <--- versioned batch IPC <--- Python migration helper
        |                                           (explicit Bun prerequisite)
        +-- strict JSON -> typed values -> RFC8785   no fallback Python encoder
        +-- revision envelope + complete snapshots  no subprocess per CRUD call
        +-- evidence target + derived key
        +-- scoped replay decision + closed errors
        |
        +--> fixed known-answer corpus
        +--> scratch Python storage -> Bun read-back

No server route / writer / public CLI / MCP activation / live migration here.
```

Bun is the **one revision/evidence canonicalizer**, not another physical schema owner. Python's existing message codec stays independent and unchanged in byte semantics. Python-to-Bun revision tests prove the adapter, result verification and persistence; they are **not evidence of two independent RFC8785 encoders**. Schema-only inspection and existing active15 migration must not start Bun.

This avoids a new dependency and a second hand-written ECMAScript-compatible float formatter. A later standalone Python encoder would need a separate proposal and conformance evidence, not a hidden fallback.

**Honcho boundary:** historical SPEC section 15 describes tier-1 table import/export (`workspaces`, `peers`, `sessions`, `session_peers`, `messages`), not conclusion/revision hashes. Its SQL/byte-compatibility promise is not a measured LanceDB round-trip guarantee. This v4 byte contract does NOT promise Honcho hash, conclusion-delete, scope-table or MCP tool parity. Scopes were explicitly considered in discussion #35; named validated selection and bounded chains remain our initial design. Representation/card parameter mapping and optional model-effort budgets belong to #32, not revision canonicalization. No live Honcho deployment or port is inferred from old notes.

## 2. Canonical JSON: full ordinary numbers, not integer-only fields

Use [RFC8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html) for revision/evidence objects and their JSON-valued columns:

- Input is strict UTF-8 JSON; reject malformed UTF-8, malformed grammar, duplicate **decoded** object keys, non-finite results and unpaired Unicode surrogates. Do not normalize Unicode, trim strings or conflate null with absent.
- Every ordinary JSON number has IEEE-754 binary64 semantics, including values written as integer literals. **Decimals are supported.** Large integer literals may round under that rule; exact arbitrary-precision integers/decimals must be strings. Dedicated Int64 protocol fields are canonical decimal strings, never ordinary JSON numbers.
- Recursively sort decoded object keys by UTF-16 code units, not Unicode code points. Arrays preserve their normalized semantic order. Build object output explicitly: inserting sorted numeric-looking keys into a JS object and calling JSON.stringify does NOT preserve the required lexical order.
- Strings/numbers serialize under the ECMAScript primitive rules required by JCS; reject non-finite values before serialization rather than letting JSON.stringify turn them into null. `-0` becomes `0`. No whitespace; output is UTF-8.
- The strict raw-text/bytes boundary is required: native JSON.parse alone loses duplicate-key evidence. Object-only helpers cannot claim to detect duplicates already lost by a caller. No getters/toJSON/class instances may affect the authoritative byte path.
- Baseline resource limits for the isolated worker: maximum 64 items, 16 MiB UTF-8 request/response, 1 MiB per JSON document, nesting depth 64. Bound before recursive parsing/encoding; exceeding a limit is a closed error, never truncation. These are worker safety bounds, not a complete public API quota policy.

Examples:

```text
{"z":-0,"x":0.000001,"y":1e20,"t":1e21}
  -> {"t":1e+21,"x":0.000001,"y":100000000000000000000,"z":0}

{"2":"b","10":"a"} -> {"10":"a","2":"b"}
{"x":1,"\u0078":2}   -> duplicate_key error, NOT last value wins
```

Normative basis: [RFC8259](https://www.rfc-editor.org/rfc/rfc8259.html), [I-JSON numeric interoperability](https://www.rfc-editor.org/rfc/rfc7493.html#section-2.2), [JCS number serialization and Appendix B](https://www.rfc-editor.org/rfc/rfc8785.html#section-3.2.2.3), [ECMAScript Number::toString](https://tc39.es/ecma262/2025/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-tostring). Python json.dumps/float repr are not adopted as JCS.

## 3. Authoritative revision envelope

The worker accepts a closed candidate revision-content object, NOT a full physical row. All listed keys are required, including explicit nulls. Extras reject.

| Envelope key | Value / mapping to the physical revision row |
|---|---|
| workspace_name | Nonempty valid-Unicode workspace handle, exact; no alias inference |
| node_id | Existing candidate opaque nanoid21 |
| base_revision_id | nanoid21 or null |
| title, body | Valid Unicode strings, including empty |
| body_format | `markdown` or `text` in this candidate |
| fields | Raw strict JSON text decoding to an object; defaulting is caller responsibility, empty is `{}` |
| author_peer_name, observer_peer_name, subject_peer_name, session_name | Nonempty exact string or null; unknown remains null |
| is_active | Boolean, no coercion |
| valid_from, valid_to | Existing canonical public UTC-millisecond timestamp or null |
| change_reason | Valid Unicode string or null |
| schema_version | Canonical Int64 wire string `"1"` for this candidate |
| canonical_version | Exact `"arra-revision/v1"` |
| term_snapshot_json | Raw strict JSON text; complete term array below |
| link_snapshot_json | Raw strict JSON text; complete link array below |
| h_metadata, internal_metadata | Null or raw strict JSON text decoding to an object |

After parsing/normalizing, the **hashed logical envelope** contains the same scalar keys and decoded `fields`/metadata, with `terms` and `links` replacing the two `*_snapshot_json` keys. Nested JSON is hashed as values, **not double-encoded JSON strings**. There are 21 envelope keys, not a second physical JSON authority. Hash domain includes workspace, node and expected base.

```text
term_snapshot_json = UTF8-text(JCS(normalized complete terms array))
link_snapshot_json = UTF8-text(JCS(normalized complete links array))
fields             = UTF8-text(JCS(parsed fields object))
h_metadata         = null or UTF8-text(JCS(parsed object))
internal_metadata  = null or UTF8-text(JCS(parsed object))

canonical_revision_bytes = UTF8(JCS(logical envelope))
content_digest = lowercase_hex(SHA256(UTF8("arra-revision/v1\n")
                                      || canonical_revision_bytes))
```

Return those normalized column values as well as the bytes/digest; do not hash one representation and persist different snapshots. Physical row `id`, `revision_no`, `operation_id`, `created_at`, `content_digest` and node head are excluded from governed content. They are allocation/retry/server state, not editable content. Author/observer/subject and BOTH metadata objects are included: changing attribution or metadata needs a new governed revision rather than an invisible edit.

A verifier of an existing row recomputes from its governed columns, rejects unsupported versions, non-canonical stored JSON and a mismatched digest. Public timestamps cannot silently round stored sub-millisecond microseconds; explicit legacy conversion/reporting remains #34. No physical data is rewritten by a validator.

This codec does not prove accepted ancestry, valid references, authorization or publication. It need not resolve peer/term/source availability. It must not invent missing attribution or default classifications during verification.

## 4. Complete snapshots and derived projections

Term entry, exact keys:

```text
term_id, vocabulary_id, vocabulary_name_snapshot,
term_name_snapshot, label_snapshot, position
```

IDs use the candidate nanoid21; vocabulary/term name snapshots are nonempty exact Unicode; label is string or null. Position is a canonical nonnegative signed-Int64 string. Require unique term_id, unique positions, and positions exactly `"0".."n-1"`; sort by numeric position before canonicalization. Empty is `[]`. Membership/cardinality against live taxonomy (including exactly one type) remains a service gate, not an inference from untrusted label snapshots.

Link entry, exact keys:

```text
position, relation, target_kind, target, excerpt,
content_hash, captured_at, capture_status, note
```

Position uses the same contiguous normalization. `relation` is one of `supports`, `contradicts`, `derived_from`, `discusses`, `corrects`, `related_to`, with directions as defined in DESIGN. `target` is the typed object below, not a second JSON string. `excerpt` and `note` are Unicode string or null. `content_hash` is lowercase SHA-256 hex or null; `captured_at` is canonical timestamp or null. `capture_status` is `captured | locator_only | unresolved`.

This slice validates those annotation fields' shape, not that an excerpt was fetched, its hash corresponds to actual source bytes, or a `captured` claim is true. This distinction must appear in tests/docs. Repeated evidence targets/relations are allowed at distinct positions. `target_key` is intentionally absent from the snapshot: derive it for the projection, never let it compete with the target.

Derived projection values are mechanically generated from the normalized snapshot and supplied workspace/revision id. No DB insertion, uniqueness, lookup, permission or reconciliation service is shipped here. Logical keys remain `(W,revision_id,term_id)` and `(W,revision_id,position)`; no link id is added.

Exact fixture/adapter composition: after a successful revision batch, use its returned normalized snapshot strings (never the raw request arrays). For each normalized link, call the target operation with the same workspace, target_kind and target; materialize projection `target` from that result's exact `target_json` and `target_key` from the SAME result. Require the returned parsed target to equal that normalized snapshot entry; do not normalize it differently or accept an unrelated target result. `target` and `verify_target` are byte-contract operations, not additional authorities. Build term projections directly from normalized term entries and the supplied W/revision id.

Physical `schema_version`, snapshot/projection positions and any other Int64 cross IPC as canonical strings; Python uses the existing parse_int64 only at the Arrow row boundary, and Bun uses bigint equivalents, never Number. Timestamp strings use the existing UTC codec, then the explicit UTC-aware -> naive timestamp[us] fixture adapter. Reverse conversion rejects non-millisecond values rather than rounding. These fixture adapters do not activate a production migration or writer.

## 5. Closed evidence targets and canonical identity

Every kind has EXACT keys as below; `?` means a required key with null permitted, not omission. All internal targets inherit the outer workspace; no nested override of workspace is accepted.

```text
node_revision {node_id, revision_id}                     both nanoid21
trace         {trace_id}                                nonempty legacy opaque id
message       {session_name, message_public_id}         handle + nanoid21
session       {session_name}                            nonempty exact handle
relic_session {source_bank, provider, session_uuid, title_snapshot?}
relic_event   {source_bank, provider, session_uuid,
               transcript_ref, event_seq, capture_digest}
code          {repo, commit, path, line_start?, line_end?}
commit        {repo, commit}
issue         {repo, number, url}
discussion    {repo, number, url, comment_id?}
url           {url}

commit value = {algorithm: "sha1" | "sha256", oid: full hex}
```

- Relic components are exact nonempty valid-Unicode strings; `session_uuid` is an opaque provider identity, not guessed from cwd and not forced to a UUID shape. Capture digest is lowercase SHA-256 hex. `event_seq` is nonnegative signed Int64 decimal text (zero-based physical position in the cited capture); adapters must explicitly map provider numbering. Digest pins capture bytes; a locator alone does not establish that capture is present.
- `repo` is **GitHub-only** `owner/repo` in this version: exactly two nonempty ASCII `[A-Za-z0-9_.-]+` segments; reject `.`/`..` segments. Lowercase ASCII, no URL/SSH coercion or provider inference. Do not strip a `.git` suffix: if present it is part of the literal repository name. A future multi-provider key needs a versioned contract, not accidental URL equivalence. This is a locator, not rename-stable repository identity.
- Git OID accepts full 40 (`sha1`) or 64 (`sha256`) hex digits and normalizes them lowercase; reject abbreviated OIDs and mutable branches/tags. Git's [hash-function transition specification](https://git-scm.com/docs/hash-function-transition#_object_names) supports both lengths.
- Code path is exact repository-relative `/`-separated text: nonempty, no leading/trailing slash, empty segment, `.`/`..` segment, backslash, NUL/control. No Unicode normalization or casefold. Lines are both null or both positive signed Int64 strings with start <= end; one-based inclusive range. Path need not exist to be a valid passive locator.
- Issue/discussion numbers and optional comment_id are positive signed Int64 decimal strings. URL validation is explicitly Bun WHATWG `new URL(raw)` WITHOUT a base, preceded by a raw check rejecting any ASCII C0/space/DEL (U+0000–U+0020, U+007F), backslash and leading/trailing Unicode whitespace. Require parsed protocol http: or https:, nonempty hostname and empty username/password. Unicode hostnames are allowed if that parser accepts them. The parsed form is validation only: preserve/hash the original exact string, including host spelling, query and fragment; never return a parser-rewritten URL. No network fetch. Issue/discussion URL is display data, not identity or proof that the URL names the declared repo/number.
- `title_snapshot` is string or null and display-only. Empty excerpt/title is distinct from null.

GitHub documents [owner/repo case-insensitive lookup](https://docs.github.com/en/rest/commits/commits#get-a-commit). Lowercasing is our versioned GitHub-locator policy; it does not prove name stability over renames or identity with unrelated hosting providers.

Identity object is normalized target minus `title_snapshot` for relic_session and minus `url` for issue/discussion; otherwise it is the complete normalized target. Thus code range and Relic capture digest participate, display text does not. Generic URL identity retains its full exact string.

```text
target_key = lowercase_hex(SHA256(UTF8("arra-target/v1\n") ||
             UTF8(JCS({workspace_name, target_kind, identity}))))
```

Reverse and direct lookup must eventually use THIS derivation. Codec tests prove equal/unequal keys and reconstruction, not an implemented query, permission check or dependency graph.

## 6. Source/revision retry scope and transport-neutral errors

Preserve the existing message v1 byte layout. Existing source_namespace is an **opaque nonempty valid-Unicode string**, exact bytes: no trim, casefold, URI equivalence or split-on-slash grammar. Existing names such as `relic/บัญชี-primary` and `relic://claude/session/transcript` retain meaning. A future #28 Relic namespace builder must be versioned and collision-tested before ingestion; it must not remap these strings silently.

Source identity scope is `(workspace_name,source_namespace,source_message_id)`; revision operation scope is `(workspace_name,"node_revision",operation_id)`. These are tuples, not delimiter-concatenated strings. Helpers receiving an existing record must check exact scope equality, not trust a caller to have queried it correctly. Source/revision digests require actual strings of exactly 64 lowercase hex characters — JS regex coercion of arrays/objects is rejected. Existing `sourceReplayOutcome` retains its three outcomes and digest domain/bytes, with this stricter runtime type check.

```text
no existing scoped record     -> new
same scope, same digest       -> idempotent; original stored identity
same scope, changed digest    -> conflict
existing record wrong scope  -> scope_mismatch error (not idempotent)
invalid digest                -> error before classification
```

No database-backed uniqueness or accepted publication is proven. For revision service #26, retry lookup is before expected-base validation so the same operation can return its original revision after the head advances. A pure replay helper does not implement that service ordering.

New contract errors have a closed serializable shape:

```text
{version:"arra-error/v1", code, path, message}
```

`path` is RFC6901 JSON Pointer, empty for root; escape `~`/`/`. Stable codes: `invalid_json`, `duplicate_key`, `invalid_unicode`, `invalid_type`, `missing_field`, `unexpected_field`, `invalid_value`, `out_of_range`, `limit_exceeded`, `unsupported_version`, `snapshot_position`, `digest_mismatch`, `target_key_mismatch`, `scope_mismatch`, `worker_failure`. Validation traversal must be deterministic (closed fields in documented order; unknown keys sorted); test codes/paths, not prose. Conflict is a successful classification/transport (`ok:true`, value.outcome=`conflict`), NOT successful application write permission. HTTP mapping/authentication/API exposure are out of scope.

## 7. Fail-closed Python batch bridge

A small internal Bun worker accepts one versioned JSON batch on stdin and writes exactly one JSON response on stdout. Logs go to stderr. One process per bounded batch; argument-array execution with shell=False, explicit script path and cwd. Total deadline is 30 seconds from process start (including stdin delivery and output drain). Each raw stdin/stdout stream is capped at 16 MiB, including an optional final LF; raw stderr is capped at 64 KiB. Check raw-byte caps BEFORE fatal UTF-8 decoding. Worker input and Python output capture are streaming/bounded: kill and reap the direct worker on timeout or overflow, with no unbounded capture_output followed by a late size check. Decode stdout strictly, not replacement characters. No environment script injection or automatic package install.

Protocol name `arra-contract-batch/v1`. All objects below are closed (exact keys), including null keys; booleans are literal. A correlation id is nonempty valid Unicode, maximum 128 UTF-8 bytes, unique within the batch. An empty items array is allowed and returns empty results. Canonical bytes cross IPC as UTF-8 JSON string, not host object; digest crosses as lowercase hex. Raw JSON-valued column strings are passed unchanged until strict parsing at the authoritative boundary. Framing serialization is not canonicalization.

```text
request = {version:"arra-contract-batch/v1", items:[{id,op,payload}]}
success = {version:"arra-contract-batch/v1", ok:true,
           results:[{id,op,value}], error:null}
failure = {version:"arra-contract-batch/v1", ok:false, results:[],
           error:{item_id:null|string, detail:{version,code,path,message}}}
```

`item_id=null` denotes a framing/transport error or an error before a unique validated item identity is known. Item errors use a payload-relative JSON Pointer; framing errors use the entire request. Validate framing/version/item identities first, then payloads in request order; first error wins. Contract-error response exits 0 (valid protocol exchange); process/infrastructure failure is nonzero and the Python adapter returns worker_failure. Output is one JSON document optionally followed by a single newline; no other stdout.

| op | Exact payload | Exact success value |
|---|---|---|
| revision | `{content}` where content is the 21-key raw-column envelope in §3 | `{canonical_json,content_digest,columns}` |
| verify_revision | `{content,content_digest}`; supplied digest and existing normalized column bytes must match | Same as revision; success attests validation of supplied bytes, not DB publication |
| target | `{workspace_name,target_kind,target}`; target is typed object | `{target_json,key_json,target_key}` |
| verify_target | `{workspace_name,target_kind,target_json,target_key}`; target_json is raw stored text, which must already be normalized/canonical | Same as target |
| source_replay | `{incoming,existing}`; shapes below | `{outcome,original_id}` |
| revision_replay | `{incoming,existing}`; shapes below | `{outcome,original_id}` |

`columns` contains exactly `{fields,term_snapshot_json,link_snapshot_json,h_metadata,internal_metadata}` with the normalized JSON texts/nulls from §3. `canonical_json` is the UTF-8 text of the logical envelope, and `key_json` is the UTF-8 text of `{workspace_name,target_kind,identity}`. Python preserves every returned JSON text byte-for-byte and recomputes the prescribed domain-separated hashes. It checks closed protocol shape, correlation ids/ops and unchanged scalar scope/version identifiers. For internal consistency ONLY, it may compare the returned logical envelope with the returned normalized columns using strict binary64 parsing (`json.loads` with parse_int=float, parse_float=float, duplicate decoded-key rejection and finite/Unicode checks). It must NOT compare raw governed input JSON using Python arbitrary-precision integer semantics or reserialize output with json.dumps. Bun alone parses/normalizes that raw input: for example input 9007199254740993 legitimately becomes 9007199254740992. These checks do not prove a hostile worker computed the right semantic answer; the local worker is trusted code whose behavior is tested against independently fixed vectors. Python is not a second canonicalizer.

```text
source incoming = {workspace_name,source_namespace,source_message_id,content_digest}
source existing = null | {workspace_name,source_namespace,source_message_id,
                          content_digest,message_public_id}
revision incoming = {workspace_name,operation_id,content_digest}
revision existing = null | {workspace_name,operation_id,content_digest,revision_id}
```

All scope components are nonempty valid-Unicode strings; existing original IDs are nanoid21. Validate incoming and existing shapes/types/digests before classification. `outcome` is `new | idempotent | conflict`. `original_id` is the existing message_public_id/revision_id ONLY for idempotent; otherwise null. A wrong existing scope rejects, even if digest matches. No global operation-id allocator/DB lookup is implied.

Limits: the transport document is bounded at 16 MiB (not the per-item 1 MiB limit); each payload and each nested raw JSON-valued column is independently bounded at 1 MiB. For an embedded payload, measure the UTF-8 bytes of its original JSON value span, including internal whitespace and escape spellings, before normalization; exclude whitespace outside that value. Retain this size during strict parsing and apply its rejection in the payload phase, after all item identities have been validated. Compact/canonical length alone is not an input-size guard. Python measures the payload bytes it actually emits; returned JSON-document strings are bounded independently on their UTF-8 bytes. Depth 64 applies to every strict parse and to the assembled logical envelope: a root container has depth 1, each nested container adds 1, scalars add none. Enforce depth and decoded-key uniqueness DURING parsing, not after native JSON.parse has built a tree or discarded duplicates. Bound response production as well as capture. Python may use the standard library's duplicate-key detection and JSON-value comparison to check protocol consistency; do not mistake this for JCS encoding.

Validate all items before returning any success. One bad item fails the whole batch with its item id + closed error and no results. Python validates protocol, response key sets, exact id/order/count, success/error exclusivity, UTF-8 validity, output caps, canonical-output field consistency and recomputed domain-separated SHA-256. Timeout/nonzero exit/malformed/extra/truncated/missing output fails before any caller write; no fallback encoder or partial success. The adapter does not open LanceDB. A fake worker may test transport failure paths, but cannot stand in for successful real Bun/Arrow evidence.

## 8. Acceptance and ownership

Neo-claude owns implementation ONLY:

- Existing `app/server/src/contracts/v1.ts` and `app/migrate-py/src/arra_migrate/contract_v1.py` for the bounded digest-type repair; do not rewrite existing message bytes.
- New focused pure TS contract module(s) and batch entrypoint under `app/server/src/contracts/`; no import into active routes/MCP startup.
- New Python batch adapter under `app/migrate-py/src/arra_migrate/`; no import into active migrator/storage path.
- New reviewed corpus under `app/migrate-py/tests/fixtures/revision-v1/`, focused Python/Bun tests, and existing codec parity tests as needed.
- Existing target `sample-rows.json` plus exporter/round-trip assertions ONLY where necessary to replace placeholder revision/snapshot/target bytes with real candidate results. Preserve physical field declarations, golden fields/provenance digest and all original drift tests.

Codex owns this document, DESIGN/addendum/issues/discussions/acceptance. No other agent edits those; no active15, target_v1 model, auth, API/MCP/CLI, dependency/lockfile, live data, R2, runtime or commit/push changes without a separate handoff.

Required proof:

1. Official RFC8785 numeric/Unicode vectors, decimal thresholds, negative zero, integer-looking key order, nested objects, Thai/emoji/control escaping; fixed EXPECTED bytes/digests, not an oracle regenerated from the implementation under test.
2. Raw duplicate decoded keys at root/nested levels, invalid Unicode/UTF-8, non-finite conversion, grammar/trailing input, bounds; ordinary fractional/large binary64 values accepted. Exact Int64 locator strings retain values >2^53.
3. Every one of 11 target kinds; missing/extra/wrong discriminator payload; repo/OID equivalence, distinct workspace/capture/line/comment/query/fragment; ignored display changes; passive URL validation with no fetch.
4. Complete snapshots: shuffled keyed objects and input position order canonicalize equally; gaps/duplicates/missing snapshot fields reject. Include one independently varied VALID NORMALIZED semantic value per mutable governed field/term/link/attribution/metadata category and assert the digest changes. Equivalent raw number spellings, -0/0, whitespace, key order and normalized snapshot order must converge. Unsupported schema/canonical-version changes reject rather than produce a digest under invented rules. Excluded allocation fields are excluded by the adapter boundary, not silently accepted in the closed content payload.
5. Strict existing message regression and sourceReplayOutcome runtime-type negatives; same/wrong-scope/retry/conflict tests for both new helpers. No claim of service ordering/uniqueness.
6. Real Python batch->Bun canonicalization; Python recomputes hashes and verifies shape/ids; fake-worker failures prove transport error handling. Entire batch rejection prevents a test caller's scratch write callback. This is an adapter test, not production transactional proof.
7. Python persists valid full rows with canonical JSON/snapshots/digests in scratch target tables; Bun reopens and verifies them; exactly mutated stored bytes/digests/target keys reject. Golden shape remains 19/228. No need to edit golden provenance: prior physical review remains scoped and valid.
8. Full Python discovery, full Bun app/CLI tests, strict TS/build, scoped Ruff/compile/diff. No new dependency; active baseline protected diff. Independent reviewer reports scope and any missing proof before local commit authorization.

#23 remains open until its OTHER specification/namespace/adapter gates are resolved. Auth, cardinality/reference service enforcement, head publication, crashes, cross-process exclusion and runtime migration are not delivered by a byte-contract package.

## Amendment 2026-09-26 (post-merge Nat style (one function per file, no file over 500 lines); behaviour-preserving moves only)

`app/migrate-py/src/arra_migrate/revision_v1.py` was 773 lines, over the 500-line
cap ruled in `docs/overnight/PLAN.md` §1 (2026-09-26 21:00 entry). To bring it
under the cap with behaviour-preserving moves only, its request-framing types
and helpers (`ContractError`, `BatchItem`, `BatchResult`, `WorkerConfig`,
`strict_binary64_loads`, `encode_request`, and the shared validators they use)
were moved byte-identical into a new sibling module,
`app/migrate-py/src/arra_migrate/contract_batch_frame.py`; `revision_v1.py`
imports them back and is now 465 lines. No canonicalization logic moved and no
public name was renamed.

This changes what "the adapter" means for §8's two containment clauses
("no import into active migrator/storage path" and "The adapter does not open
LanceDB"): both clauses now apply to `contract_batch_frame.py` as well as
`revision_v1.py`. `app/migrate-py/tests/test_revision_v1.py::IsolationTests`
was updated accordingly -- `test_no_active_python_path_imports_the_adapter`
and `test_the_adapter_itself_imports_no_lancedb_or_storage` now scan/check
both files as one unit, via the new `ADAPTER_UNIT` tuple. This EXTENDS the
guard's coverage (closing a gap where code moved out of `revision_v1.py`
would have gone unchecked); nothing already enforced was loosened, and no
existing assertion was deleted. Verified by temporarily adding
`from .contract_batch_frame import encode_request, ContractError` to
`__main__.py` in a scratch copy: `test_no_active_python_path_imports_the_adapter`
fails as expected, then passes again once removed.

## Amendment 2026-09-26 (post-merge #33 AC1/AC3 + R6 (sealed vocabulary) + R10 (conclusion reserved) + R12)

No server behaviour, codec or field changes. This records a new WRITER of
`link_snapshot_json`, the v2 UI, and the exact subset it writes, per
`docs/overnight/DECISIONS.md` R6, R10 and R12.

- **Before**: the v2 UI sent `link_snapshot_json: "[]"` on every
  `publishRevision`, so no browser path could cite or correct (#33 AC1).
- **Cite**: the publish form builds entries in the §4 LINK_KEYS shape: contiguous decimal
  `position`, a `relation` from the closed six, and a closed per-kind `target` for five of
  the eleven §5 kinds (`node_revision`, `message`, `session`, `trace`, `url`). `excerpt`,
  `content_hash` and `captured_at` are always `null`, and `capture_status` is always
  `locator_only`. The UI fetches and hashes nothing, and §4 says a `captured` claim is not
  verified, so the UI never makes one. The `code`, `commit`, `issue`, `discussion` and
  `relic_*` kinds are not offered, because their identity (a git OID or a capture digest)
  is not something a person types. Resolution of internal kinds stays with the server
  (`invalid_reference`), and the UI shows that refusal verbatim.
- **Correct** is a new node with no base. Its single `type` term is `correction`, a sealed
  TYPE_TERM (R6: the vocabulary cannot be extended from any transport, so the UI picks
  from the existing five). It is never `conclusion`, which is a separate reserved term
  (R10). Link 0 is `corrects` → `node_revision`, pinned to the exact revision being
  corrected, and any extra evidence follows from position 1. The corrected revision is not
  edited. The correction reaches it only as reverse evidence (`scanDependents`).
- Pinned by `app/ui/v2/src/state/buildLinkSnapshot.test.ts`,
  `buildCorrection.test.ts`, `api/publishRevision.test.ts` and
  `components/citeCorrect.test.ts`.
