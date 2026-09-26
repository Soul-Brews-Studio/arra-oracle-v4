# Source ingestion and legacy boundary v1

Status: **ACCEPTED ISOLATED IMPLEMENTATION** at `33e3c44`; contract review and independent acceptance completed. This does not activate a service or prove durable ingestion. Reviewed 2026-09-20; all four shape/trust/order/precision decisions and the final Arrow-scope wording correction are resolved. Root-owned continuation of #23 after accepted byte contract `6289311` and scoped-read repair `7dd21d0`. No schema change, ingestion endpoint, migration, runtime activation, credential or live write is authorized by this contract.

## 1. Preserve existing bytes

The seven-field message envelope, field order, UTF-8 escaping, explicit nulls and `arra-message/v1\n` domain in `v1-codecs.md` remain unchanged. This document is not a switch of the message codec to JCS. Workspace/session, local row ID, public ID, sequence, legacy `created_at` and server `ingested_at` remain outside that envelope.

A sourced message's stored `source_payload_digest` is recomputed from the accepted envelope by the trusted ingestion boundary. A supplied digest is optional verification input, never authority; mismatch rejects before allocation/write. Existing `source_replay` calls call this value `content_digest`; translate the field name explicitly, without changing its bytes or the accepted batch operation shape.

## 2. Namespace and source identity

`source_namespace` and `source_message_id` are nonempty valid-Unicode strings, exact UTF-8 identity. Do not trim, casefold, normalize Unicode, parse numbers, remove trailing slashes or reinterpret URI-like strings. This preserves the accepted codec grammar, including distinctions between whitespace-bearing names. The adapter configuration must deliberately choose the namespace; accepting the grammar does not authorize arbitrary sources.

The namespace must cover the source's real ID-uniqueness domain. A session-local source ID requires session-distinct configured namespaces. Provider/account/session components may inform explicit configuration, but must not be guessed from cwd or apparent conversation adjacency. Namespace changes are identity migrations, not cosmetic edits. A Relic bank is not automatically a v4 workspace.

## 3. Source-column validity

| Mode | namespace | source_message_id | source_payload_digest | source_created_at |
|---|---|---|---|---|
| Locally authored | null | null | null | null |
| Sourced | nonempty | nonempty | recomputed lowercase SHA256 | canonical time or null |

Reject every partial source triple and any non-null source time without that triple. Target `ingested_at` is required for both modes. Nullable Arrow columns do not enforce this predicate. No source identity or original source time is inferred merely from an existing row's ID or `created_at`.

## 4. Time policy

Public new-write times use the accepted exact UTC millisecond format. Physical target timestamps remain timezone-less Arrow microseconds, semantically UTC. Production/migration Arrow adapters must check raw microsecond divisibility before JavaScript Date/number conversion; those accessor paths remain #28/#34 work outside this pure module. This module enforces raw-microsecond precision only for the explicit legacy.created_at_us input in section8.3; its other timestamp inputs are canonical strings.

For NEW ingestion:
- `ingested_at` is the service-selected intake time for the new accepted record, not caller input and not recomputed on retry. Durable acknowledgment still waits for #28's write protocol.
- `source_created_at` is the source-provided canonical time or null; it may predate intake by years. Missing source time remains missing.
- Compatibility `created_at = source_created_at ?? ingested_at`. Sequence, not this timestamp, controls local conversation order.

For a LEGACY COPY under #34:
- Preserve legacy `created_at`, local ID, public ID and established session sequence; do not reinterpret them as original source facts.
- When no authoritative ingestion time exists, use an explicit migration intake timestamp for the copy and record that basis in the migration report. Do NOT silently set `ingested_at = created_at`, which would assert an unobserved historical ingestion time.
- Migration retries reuse the frozen intake timestamp in their manifest; the wall clock must not rewrite mapped rows on retry.
- Sub-millisecond timestamps or unresolvable ID collisions are reported and held for policy resolution, not rounded or overwritten. This contract does not authorize dropping those rows.

## 5. IDs, destinations and replay

New external `public_id` uses the accepted nanoid21 format; physical `id` and `seq_in_session` are Int64 with canonical decimal-string target wire encoding. `source_message_id` remains opaque: `00042` and `42` are distinct. Retained legacy handles must be explicitly mapped if they violate new-handle rules, never silently regenerated.

Replay identity stays exactly `(workspace_name, source_namespace, source_message_id)`. Lookup is scoped and authorized before exposing an existing message. Same identity/digest returns the existing public ID without allocating new local ID, sequence, timestamp or row. Same identity/different digest is conflict. A supplied existing record outside the identity scope is `scope_mismatch` as already defined by the accepted classifier.

The replay tuple does not contain destination session. Ingestion must additionally check an existing message's stored session against the requested destination: a different destination is a `scope_mismatch`, not permission to duplicate or move the message. The pure existing replay helper remains unchanged; destination validation belongs to the ingestion service wrapper.

`in_reply_to` is a public message handle, resolved within the authorized conversation scope. New per-session sequence allocation is serialized by #28; timestamps and opaque source IDs must not be used as a substitute for sequence allocation. Historical source-order preservation and partial-batch recovery need an explicit #28 importer policy, not guesses in this validator.

## 6. Implementation boundary and enforcement owners

```text
adapter configuration + input
  -> scope authorization (#25)
  -> closed source/time/identity validation (#23 contract)
  -> scoped existing-message lookup + destination check (#28)
  -> accepted digest/replay classifier (already implemented)
  -> new-record allocation/serialized write only if new (#28)
  -> durable result / original ID on retry
```

The accepted isolated implementation at `33e3c44` provides pure source-state validators and mapping fixtures. Its contract prohibits ID allocation, clock reads, LanceDB writes and an independent canonicalization rule; acceptance does not establish durable service behavior. Service uniqueness, sequence allocation, authorization, writer exclusion and durable acknowledgment are not proved by that package. #31 owns shared HTTP/MCP/CLI error mapping; use the already accepted closed error vocabulary rather than inventing another error envelope.

## 7. Required proof before dispatch/acceptance

1. Existing Python/TS message vectors remain byte-identical; seven-field envelope and digest domain unchanged.
2. Namespace/source-ID exactness, including Thai, leading zeros, slash/case/space differences; empty and invalid Unicode reject.
3. All 16 source-column presence combinations: only local all-null and sourced triple-with-optional-time pass. Validate values as well as presence.
4. Supplied digest mismatch rejects; ingestion time and allocated fields do not affect message digest; each governed envelope field does.
5. Local/sourced canonical-string time mapping and exact UTC; legacy.created_at_us divisibility and far-calendar rejection before conversion. No claim of general Arrow-accessor coverage; no invented source time.
6. Pure fixtures preserve existing replay classifications; service tests later prove replay consumes no allocation/write and cross-session destination reuse is rejected.
7. Copy fixtures preserve legacy IDs/time/order, record explicit migration-intake basis, replay the same mapping deterministically, and report collisions/precision failures without losing rows.
8. No active-path imports, dependency changes, live writes or target-registry activation for isolated contract work.

This list records acceptance requirements, not standalone test results. The isolated package was accepted at `33e3c44`; see [delivery gates](delivery-gates.md) for evidence and limits. #23 contract-definition work is satisfied, with tracker closure pending documentation reconciliation. #28 durable service enforcement remains open; cross-row collisions and copy rehearsal remain #34.

## 8. Closed pure interface (normative)

Implement one isolated TS module, `contracts/source-ingestion-v1.ts`. It consumes strictly parsed JSON values using the existing parser/closed validators; no new worker op, API/MCP route or Python encoder. Four exported functions accept a raw JSON string so duplicate decoded keys, invalid Unicode and size/depth errors are checked before native object conversion. Each root document is at most 1 MiB, depth64, using existing rules. Functions return plain JSON-safe objects or throw the existing `ContractError`; no success/error transport wrapper is added. Direct JSON text input distinguishes a validator from the future authorized service that constructs that input.

All keys below are REQUIRED, including nullable ones. Objects are closed; no hidden extra metadata or row allocation fields. `S` = nonempty valid-Unicode exact string; `T` = accepted canonical UTC millisecond timestamp; `N` = nanoid21; `I` = accepted signed Int64 decimal string; `H` = lowercase SHA256 hex. `str` may be empty but must be valid Unicode. The rows returned are boundary fragments, NOT complete target Message rows.

### 8.1 `prepareNewMessage(json)`

```text
input = {
  context: {workspace_name:S, session_name:S, intake_at:T,
            source_namespace:S|null},
  message: {peer_name:S, role:str|null, content:str, in_reply_to:N|null},
  source: null | {source_message_id:S, source_created_at:T|null,
                  supplied_digest:H|null}
}

output = {
  workspace_name, session_name, peer_name, role, content, in_reply_to,
  source_namespace, source_message_id, source_payload_digest,
  source_created_at, created_at, ingested_at
}
```

`context` is constructed by trusted service/adapter configuration after authorization, never copied wholesale from a remote request. This pure function validates its shape, not its trust. **Configuration injects the namespace**: untrusted `message`/`source` may not contain `source_namespace`; an attempt is `unexpected_field`. There is no competing caller namespace to compare or overwrite.

With `source:null`, context namespace must be null; output source quartet is all null, created_at and ingested_at equal context intake. With sourced input, context namespace must be non-null, source ID/time are copied exactly, and the digest is recomputed with the existing messageDigest over its exact seven fields (namespace injected from context). A non-null supplied digest must equal that result. `created_at = source_created_at ?? intake_at`, `ingested_at = intake_at`. Output excludes supplied_digest. No ID/sequence allocation and no clock read occurs here.

### 8.2 `validateStoredSourceState(json)`

```text
input/output = {
  source_namespace:S|null, source_message_id:S|null,
  source_payload_digest:H|null, source_created_at:T|null,
  ingested_at:T
}
```

Return the same values in listed field order after value validation and the section3 presence predicate. Digest is SHAPE ONLY here because this input lacks the message envelope; do not claim recomputation. Validate a full sourced record through prepareNewMessage/service checks where content is available.

### 8.3 `mapLegacyMessageBoundary(json)`

```text
input = {
  context: {workspace_name:S, session_name:S, migration_intake_at:T},
  legacy: {id:I, public_id:N, seq_in_session:I, created_at_us:I,
           source_namespace:null, source_message_id:null,
           source_payload_digest:null, source_created_at:null}
}
output = {
  workspace_name, session_name, id, public_id, seq_in_session,
  created_at, ingested_at,
  source_namespace:null, source_message_id:null,
  source_payload_digest:null, source_created_at:null,
  assumptions:["ingested_at=migration_intake;original_ingestion_unknown"]
}
```

This function is explicitly for source-less legacy records. Existing sourced rows are not stripped: any non-null legacy source field rejects and is held for a separate sourced-row migration path. `created_at_us` is the exact physical epoch microsecond Int64 text exported before any lossy JS accessor; require divisibility by1000, then require the resulting millisecond instant in Gregorian years0001–9999. Format it with the accepted UTC codec. Preserve id/public_id/sequence exactly, including valid signed Int64 values; no new positivity rule is invented. `ingested_at` equals the frozen context migration-intake time; assumptions is a returned report field, not a new database column.

Precision policy covers legacy `created_at_us` here; migration_intake_at is already canonical milliseconds, and legacy source time is necessarily null. Other retained physical time columns are NOT silently converted by this function: #34 must separately enumerate/rehearse them. Invalid nanoid legacy handles and collisions are held for #34 mapping; this single-row function cannot discover dataset collisions and must not claim to. No complete row or dataset mutation is produced.

### 8.4 `classifyMessageDestinationReplay(json)`

```text
input = {
  requested: {workspace_name:S, session_name:S},
  incoming: {source_namespace:S, source_message_id:S,
             source_payload_digest:H},
  existing: null | {workspace_name:S, session_name:S,
                   source_namespace:S, source_message_id:S,
                   source_payload_digest:H, public_id:N}
}
output = {outcome:"new"|"idempotent"|"conflict", original_id:N|null}
```

After structural/value validation, compare existing workspace then session against requested, rejecting a mismatch. Then project into the UNCHANGED accepted sourceReplayOp: requested workspace becomes incoming workspace; source_payload_digest is renamed content_digest; existing public_id is renamed message_public_id; session is omitted from that helper's closed shape. Re-anchor helper errors to this wrapper's actual input paths (`content_digest` -> `source_payload_digest`, `message_public_id` -> `public_id`). Namespace/source-ID scope checks and classification follow the existing helper. Null existing returns new; this is not evidence a database lookup occurred or a write is permitted.

## 9. Deterministic errors and traversal

Strict parse errors retain the existing parser's code/path. After parse, walk closed shapes depth-first in the listed field order: at each object check missing keys in listed order, then unexpected keys sorted by UTF-16 order, then field types/formats and nested shapes in listed order. These structural/value checks for the WHOLE input precede semantic relationships/comparisons. Thus malformed existing digest outranks a destination mismatch; a valid but differing digest does not outrank destination scope. Do not catch arbitrary implementation exceptions and relabel them as caller errors.

| Condition | Code | Pointer |
|---|---|---|
| Non-string, wrong object/array/null shape | invalid_type | offending field/object |
| Missing/extra key | missing_field / unexpected_field | missing/extra key (RFC6901 escaped) |
| Lone surrogate | invalid_unicode | offending value/key location |
| Empty S; malformed H/N; noncanonical Int64 text | invalid_value | offending field |
| Int64 overflow | out_of_range | offending field |
| Invalid/noncanonical T, including sub-ms public spelling | invalid_value | offending time field |
| prepareNew source mode and configured namespace disagree | invalid_value | /context/source_namespace |
| Valid supplied digest differs from recomputed digest | digest_mismatch | /source/supplied_digest |
| Stored source triple partially present | invalid_value | /source_namespace |
| Stored source time non-null with all-null triple | invalid_value | /source_created_at |
| Legacy source field non-null | invalid_value | first such field in listed order |
| Legacy raw micros not divisible by1000 or calendar outside supported range | out_of_range | /legacy/created_at_us |
| Replay destination workspace/session differs | scope_mismatch | /existing/workspace_name then /existing/session_name |
| Replay namespace/source-ID differs | scope_mismatch | /existing/source_namespace then /existing/source_message_id |

Within semantic validation: prepareNew checks mode/config before supplied-digest equality; stored-state checks partial triple before source time; legacy checks source-less status before physical-time precision; replay checks destination before namespace/ID/digest comparison. A digest's malformed syntax is a value error before any comparison, not digest_mismatch. Codes/paths are contractual; human messages are not.

## 10. Bounded acceptance clarification

The section7 allocation/no-write expectations for a real ingestion service remain #28 gates. For this isolated slice prove purity (injected time and identity retained, no allocator/clock/database/model dependencies), exact mapping and existing classifier composition instead; do not claim actual durable replay or uniqueness. Test all16 source-presence combinations, per-operation missing/extra/wrong values and deterministic competing-error cases; fixed expected outputs for local, sourced and legacy modes; negative epoch and far-calendar physical microseconds; namespace injection and source ID leading zeros. Preserve existing message byte vectors and all active paths. Collision handling and sourced legacy migration remain explicit #34 gates, not silently declared complete by a single-row fixture.

## Amendment 2026-09-26 (overnight R15)

**Change**: `messages.ingested_at` (target-19, `arra_migrate.target_v1.core.Message`) is
recorded here as an explicit, permanent exception to SPEC §15.1's tier-1 rule ("v4 may
add **nullable** columns and nothing else") and to §15.2 invariant 1 ("additive nullable
columns only"). `ingested_at` is `NOT NULL` on the target-19 physical schema
(`app/migrate-py/src/arra_migrate/target_v1/core.py`) and on the golden schema fixture,
by original design (§2 above: "`ingested_at` is the service-selected intake time for the
new accepted record, not caller input and not recomputed on retry"). A nullable
`ingested_at` would let a row exist with no recorded intake time, which this contract's
§2/§3 never permitted for either the sourced or the locally-authored path.

**Reason**: issue #8 (SPEC §15.5 round-trip proof) measured this contradiction directly
against the physical schema (`.tmp/understand/issue-8/repro_output.txt`, finding under
"TYPE / NULLABILITY": *"messages.ingested_at is a NOT NULL v4 addition ... This
contradicts §15.1/§15.2 inv.1 'nullable columns only'"*). The column was correct when
this contract was written; §15.1's blanket nullability rule is what did not anticipate a
column whose whole job is to always carry a real value. Making it nullable to satisfy
§15.1 literally would reopen exactly the ambiguity §2 was written to close (a row with an
unrecorded, unknowable ingestion time) for one clause's sake.

**Scope**: this is a recorded exception, not a precedent for future NOT-NULL additions --
each one still needs its own reviewed exception here, argued the same way. The Honcho
round-trip harness (`app/migrate-py/src/arra_migrate/honcho_roundtrip/bundle.py`,
`LOSSY_FIELDS`) declares `messages.ingested_at` lossy for exactly this reason: stock
Honcho's `Message` schema has no ingestion-time concept at all, so the column cannot
round-trip regardless of its nullability.

**Cites**: `docs/overnight/DECISIONS.md` R15 (`v4-overnight`, 2026-09-26); SPEC.md §15.1,
§15.2 invariant 1.
