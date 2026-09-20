# Delivery gates after the isolated source-contract slice

Evidence snapshot: 2026-09-20, local commit `11cf7235a815234d305f338982cf2cf53ef21197`. This ledger updates delivery status, not the logical schema or an authorization policy. No runtime activation is implied.

## Three distinct states

```text
RUNNING SPIKE (NOT RESTARTED)  ACCEPTED LOCAL SOURCE             REMAINING PRODUCT WORK
15 tables /152 fields         target19 /228 isolated fields      serialized writer
8 memory-spike tools          canonical bytes/source mappings   publication + ingestion
no new auth activation        auth for existing transports      target-service access
local-only deployment         scratch fixtures/client gates     taxonomy/search/context/UI
```

These columns are distinct states, not an executed migration. Target19 and revision/source persistence services remain isolated. Local authorization integration now uses the pure policy and strict parsing helpers for the existing transports; that does not activate target tables or restart the running spike. The 19-table change is 15 - memories - memory_terms + six target tables, not 15 + four additions.

## Evidence and responsibility ledger

| Requirement | Current evidence / status | Remaining enforcement or delivery owner |
|---|---|---|
| Target physical schema, types/nullability/vector dimensions | Accepted `8618094`; 19 tables/228 fields; static golden and persisted drift fixtures | Defined by #23; remaining copy-migration proof: #34 |
| Revision/evidence bytes, typed target identities, source/revision replay classification | Accepted isolated package `6289311`; fixed vectors, real Python/Bun and persisted round trips | Defined by #23; remaining service use and accepted-operation semantics: #26/#28 |
| New opaque IDs, Int64 wire strings, exact UTC millisecond strings | Existing v1 codecs; target model shape and raw-microsecond fixture checks | Accepted pure boundary mapping at `33e3c44`; #34 conversion/rejection rehearsal |
| Source columns and source-vs-ingestion time | Accepted pure source/legacy boundary package `33e3c44`; namespace injection, all-or-none predicate, time mapping and destination-aware replay | #23 contract definition is satisfied; no durable ingestion or uniqueness follows from pure mapping. #31 owns shared runtime transport error consistency; #28 ingestion validates scope, resolves replay and allocates sequence under serialization |
| Exactly one type, zero/one horizon; allowed terms and same-workspace references | DESIGN sections 7-8 define rules; physical models and immutable snapshots do not enforce them | #27 service validators; #26 validates complete revision before publication; #25 authorizes |
| Evidence truth and direct/reverse traversal | Canonical target keys proved; capture truth, permissions and query results not proved by hashes | #28 verifies pinned-source handling and equality of direct/reverse queries; #25 access |
| Principal vs peer/author/observer/subject | Separate audit principal/credential/policy attribution accepted at `11cf723`; domain peer fields unchanged | #28 target-content propagation; #34 legacy unknown-attribution preservation |
| Current MCP scope, logs, redaction, rejected extra route | Accepted store-boundary repair `7dd21d0`; required scope precedes storage/model access. #24 closed with targeted and two-bank evidence | #24 closes measured spike gates only; no authentication claim |
| Authorization / token expiry, revocation, grants | Isolated policy `eb281cc` and local existing-transport integration `11cf723` accepted; no running-service restart | #25 remains open for target sessions/traces/evidence/configuration and cross-reference coverage; deployment separately gated |
| Revision publication, retries, stale-base conflicts, recovery, writer exclusion | Byte validators/classifiers are prerequisites only | #26 fault-injected persistence protocol and process-level ownership |
| Supersession and retirement | Physical contract, flat lifecycle design; no target service proof | #29 expected-revision/authorization/append-only event behavior |
| Revision-aware embedding/search reconciliation | Current spike embedding exists; target chunks shape does not ship revision-aware search | #30 save-first projections, profile binding and reconciliation; #7/#10 Thai recall/legacy defect measurements |
| Shared HTTP/MCP/CLI methods | Local source routes existing eight tools and HTTP/CLI/browser calls through admission at `11cf723`; new codecs are not tools | #31 target methods and explicit legacy adapters; #25 authorization must extend with them |
| Context, representation and peer/session chat | Design only for target service | #32 bounded permitted context, evidence, explicit-save actions; reusable scopes may be validated config, not another table |
| Knowledge Explorer/revision diff/evidence UI | Target UI not proven by backend fixtures | #33 browser-level acceptance |
| Honcho interoperability | Historical SPEC section15 is an unproved tier-1 claim; no revision hash coupling | #8 real target deployment identity + export/import test, no reliance on dead endpoint |
| Copy migration and release | No live activation/migration authorized | #34 non-destructive rehearsal, compatibility and deployment checks |
| Serena / CodeGraph | Native MCP bridge calls succeed; refreshed source index | #37 tooling evidence; neither call-graph counts nor connectivity proves product behavior |

## Next gates, without changing scope

1. Preserve #24 accepted scope enforcement and fixture-limited redaction wording; it is not authentication.
2. Record #23 final contract acceptance using the physical, byte and source commits. Downstream enforcement remains assigned in the ledger above; closing a contract gate does not complete those services.
3. Preserve accepted #25 existing-transport admission and review #26 persistence before implementing durable target services. Extend #25 coverage with each new target service; neither RFC8785 nor a single-writer comment supplies those guarantees.
4. Deliver #27-#34 through bounded slices against the shared service, rather than creating independent MCP-only behavior.

#23 contract-definition gates are satisfied by the reviewed physical, byte and source contracts. Tracker closure is recorded separately after this status reconciliation; no runtime completion follows. Every later issue remains independently subject to its acceptance criteria. PR #1 is historical and unchanged; replacement/merge decisions are separate from local acceptance.

## Latest verification scope

At `11cf723`: root independently ran 82 Python tests and 347 Bun tests /2188 assertions, strict TypeScript, build, changed-Python Ruff and tracked/untracked whitespace checks; the frozen files remained byte-stable. Eight independent route probes returned the expected rejection with zero storage effects. The exact 20 committed paths, parent and blob hashes matched that acceptance snapshot. The implementer reran the same suites on the committed tree. Whole-tree lint is not claimed clean. No push, restart, real credential provisioning or live dataset/R2 write occurred.

Limits: header checks reject the measured post-flattening grammar, not raw line counts; enumerated source-text scans are not import resolution; secret-bearing fixture redaction is not universal secret detection. The shared facade covers existing operations, not future target-service references. #25 remains open.

Earlier source-contract evidence at `33e3c44`: accepted stable-tree Python discovery 79 tests; Bun full app/CLI suite 168 tests /1520 assertions; strict TypeScript, build and whitespace checks passed. Root independently verified the four committed blobs, exact changed-file set and parent against captured acceptance evidence, and ran 61 independent source-boundary assertions before commit. Whole-tree lint is not claimed clean. No push, release, production authorization or service-invariant proof is claimed.

See [source acceptance](https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/23#issuecomment-5749867140) and [scope closure](https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/24#issuecomment-5749732127). Earlier physical/byte evidence remains in #23; this ledger does not replace it.
