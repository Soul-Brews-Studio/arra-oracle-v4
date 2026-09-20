> Historical slice report: the target registry and revision/evidence codecs listed below as remaining work were subsequently accepted **in isolation**, not activated. See [delivery gates](delivery-gates.md) for current status; the original verification counts remain historical.

# Candidate v1 codecs — #23, 2026-09-20

**Implemented as isolated contract evidence, not activated in legacy endpoints or the migrator.** This is a partial #23 slice, not the complete 19-table contract or authorization to migrate existing data. The approved product direction remains Python schema ownership, TypeScript application, and local-first LanceDB.

```text
Python contract_v1.py ---- exact UTF-8 / digest fixtures ---- TS contracts/v1.ts
          |
          +---- Python LanceModel fixture --> scratch LanceDB --> Bun reads

Active15 registry / current8 MCP tools / live dataset: unchanged
Target19 model registry / revision publication: still to implement and prove
```

## Encodings under test

| Value | Candidate encoding |
|---|---|
| New opaque ID | 21 characters, `[A-Za-z0-9_-]`, cryptographic generation; not sortable or authorization |
| Signed Int64 | Always canonical decimal string externally; Python int / TS bigint internally; no leading zeros, plus, whitespace, `-0`, or overflow |
| Public time | `YYYY-MM-DDTHH:mm:ss.SSSZ`, Gregorian years 0001–9999, exact milliseconds, UTC only |
| Physical time fixture | Arrow `timestamp[us]` without timezone, semantically UTC; explicitly converted from aware UTC Python datetime |
| Text | Exact UTF-8, no Unicode normalization; reject unpaired surrogates |
| Source message | Closed ordered object below; omission differs from explicit null |

The scratch schema verifies the current 384-dimensional nullable Float32 vector shape, not a decision that every future embedding profile must have that dimension. It also verifies required/nullable fields, Int64 maximum preservation and a real 2026 UTC timestamp, including both null and non-null source times. It does not prove every Arrow timestamp throughout years 0001–9999 decodes losslessly through all JavaScript accessors; public timestamp parsing and Arrow storage decoding are separate gates.

Timezone-less Arrow is a deliberate candidate convention matching the current Python LanceModels, not an assertion that naive datetimes inherently mean UTC. The fixture adapter owns enforcement: parse an exact `Z` timestamp into an aware UTC datetime **before** stripping tzinfo for Arrow. Future service/migration adapters must enforce that same boundary and label decoded values UTC; they must not pass an arbitrary naive local datetime through. That production adapter and the full timestamp contract are still #23 work.

## Closed message envelope

Field order is fixed, independently of caller insertion order:

```text
source_namespace     nonempty string
source_message_id    nonempty string
peer_name            nonempty string
role                 string or null
content              string, including empty
source_created_at    canonical public timestamp or null
in_reply_to          string or null
```

All seven keys are required. Extra keys are rejected. JSON uses compact separators, normal JSON escaping and unescaped valid Unicode, encoded as UTF-8. The digest is lowercase SHA-256 of:

```text
UTF8("arra-message/v1\n") || canonical_message_bytes
```

This encodes a source-message identity payload, not arbitrary extension-field JSON. Server ingestion time is intentionally not in this envelope; a future service must select the versioned fields explicitly rather than pass its whole request into the codec. Source namespace grammar and workspace-scoped source replay checks remain service-contract work. An equal digest is not permission or proof of accepted ingestion.

## Tests and reproduction

From repository root, use the existing project dependencies:

```sh
# If the Python environment has not been provisioned:
uv sync --project app/migrate-py --frozen

PYTHONPATH=app/migrate-py/src app/migrate-py/.venv/bin/python \
  -m unittest discover -s app/migrate-py/tests -v
bun run --cwd app/server test
bun run --cwd app/server typecheck
bun run --cwd app/server build
ruff check app/migrate-py/src/arra_migrate/contract_v1.py app/migrate-py/tests
git diff --check
```

The Bun cross-language suite intentionally fails rather than silently skips when Python/LanceDB is unavailable. `ARRA_CONTRACT_PYTHON` may select an equivalent provisioned interpreter. It creates a unique temporary directory; the Python exporter refuses an existing dataset child, never uses overwrite/reset, and does not touch live data. The retry rejection proves overwrite prevention only, not schema-drift rejection.

Coverage: cryptographic ID shape, strict Int64/time boundaries, canonical bytes/domain-separated digest, Thai/emoji/control text, explicit null, missing/extra keys, insertion order and invalid Unicode. A 96-case corpus is evaluated independently by Python and TypeScript, comparing both rejection and exact successful bytes/digests. Another test uses a Python-declared LanceModel table and reads actual Arrow schema/rows from Bun; it is not a TypeScript-only fake schema.

## Remaining #23 gates

- Exact target19 models/manifest, all field types/nullability, schema drift negatives and legacy adapters. Do not replace the active15 registry with this fixture.
- Revision scalar/term/link snapshot canonicalization, including extension-field number rules and evidence target keys. The message codec is not a generic JSON canonicalizer.
- Source namespace grammar, replay error shapes and scoped operation semantics.
- Timestamp decoding precision across supported Arrow ranges; explicit handling of legacy microseconds beyond the chosen public precision.
- Revision authority decision, orphan ordinals, deterministic association projections, writer/migrator exclusion, and fault-tested head publication under #26.
- No automatic reinterpretation of existing IDs, timestamps or value-dependent legacy Int64 responses. Compatibility must be explicit.

No runtime authentication, message ingestion, conclusions, context/chat or additional MCP tool is shipped by this codec slice.

## Verification record — 2026-09-20

- Full Bun app/CLI suite: **64 tests / 474 assertions, zero failures**.
- Python codec suite: **17 tests, zero failures**.
- Strict TypeScript, Bun build, scoped Python Ruff and diff checks: passed.
- Independent code review: approved this isolated codec slice only, not #23 completion.
- Serena MCP SDK: 23-tool catalogue and symbol overview of the new TS codec passed.
- CodeGraph MCP SDK: filtered 21-tool probe passed after full reindex; all **46 source hashes** matched. Known missing-caller limitations still apply. Neither SDK check proves native-client tool exposure.

No new dependency, live data write, runtime API change, registry activation or R2 operation occurred. The fixture database is temporary and model-free.
