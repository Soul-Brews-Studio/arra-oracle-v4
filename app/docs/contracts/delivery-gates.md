# Delivery gates after the isolated byte-contract slice

Evidence snapshot: 2026-09-20 19:07 GMT+7, local commit `628931176afee0be6b0e59f06df732dd9a26ea86`. This ledger updates delivery status, not the logical schema or an authorization policy. No runtime activation is implied.

## Three distinct states

```text
ACTIVE RUNTIME              ACCEPTED ISOLATED CONTRACTS       REMAINING PRODUCT WORK
15 tables /152 fields  -->  target19 /228 physical fields --> auth + serialized writer
8 memory-spike tools        canonical revision/evidence      publication + ingestion
no authentication           bounded Python/Bun adapter       taxonomy + lifecycle
local-only deployment       scratch persisted fixtures      search + context + UI
```

The first arrow is NOT an executed migration. Accepted contracts remain outside active route/MCP/CLI and migrator paths. The 19-table change is 15 - memories - memory_terms + six target tables, not 15 + four additions.

## Evidence and responsibility ledger

| Requirement | Current evidence / status | Remaining enforcement or delivery owner |
|---|---|---|
| Target physical schema, types/nullability/vector dimensions | Accepted `8618094`; 19 tables/228 fields; static golden and persisted drift fixtures | #23 maintains physical contract; #34 proves copy migration |
| Revision/evidence bytes, typed target identities, source/revision replay classification | Accepted isolated package `6289311`; fixed vectors, real Python/Bun and persisted round trips | #23 contract; service use and accepted-operation semantics remain #26/#28 |
| New opaque IDs, Int64 wire strings, exact UTC millisecond strings | Existing v1 codecs; target model shape and raw-microsecond fixture checks | #23 production/legacy boundary mapping; #34 conversion/rejection rehearsal |
| Source columns and source-vs-ingestion time | Declared in target Message; message digest and scoped replay helper exist | #23 must finish source namespace/all-or-none and legacy/production boundary mapping; closed arra-error/v1 and scoped replay classifiers are already accepted in isolation. #31 owns shared runtime transport error consistency; #28 ingestion validates scope, resolves replay and allocates sequence under serialization |
| Exactly one type, zero/one horizon; allowed terms and same-workspace references | DESIGN sections 7-8 define rules; physical models and immutable snapshots do not enforce them | #27 service validators; #26 validates complete revision before publication; #25 authorizes |
| Evidence truth and direct/reverse traversal | Canonical target keys proved; capture truth, permissions and query results not proved by hashes | #28 verifies pinned-source handling and equality of direct/reverse queries; #25 access |
| Principal vs peer/author/observer/subject | Distinct design roles; transport user-agent separation covered by existing MCP tests | #25 credential/grant contract; #28 propagation; #34 legacy unknown-attribution preservation |
| Current MCP scope, logs, redaction, rejected extra route | Foundation implementation/test evidence exists; inventory found optional scope in store read helpers. A bounded db.ts/test repair is dispatched; #24 remains open pending independent verification | #24 closes measured spike gates only; no authentication claim |
| Authorization / token expiry, revocation, grants | Not implemented; runtime reports auth absent | #25 reviewed contract and fail-closed shared service boundary before external exposure |
| Revision publication, retries, stale-base conflicts, recovery, writer exclusion | Byte validators/classifiers are prerequisites only | #26 fault-injected persistence protocol and process-level ownership |
| Supersession and retirement | Physical contract, flat lifecycle design; no target service proof | #29 expected-revision/authorization/append-only event behavior |
| Revision-aware embedding/search reconciliation | Current spike embedding exists; target chunks shape does not ship revision-aware search | #30 save-first projections, profile binding and reconciliation; #7/#10 Thai recall/legacy defect measurements |
| Shared HTTP/MCP/CLI methods | Eight legacy MCP tools remain active; new codecs are not tools | #31 one validated service and explicit legacy adapters; authorization first |
| Context, representation and peer/session chat | Design only for target service | #32 bounded permitted context, evidence, explicit-save actions; reusable scopes may be validated config, not another table |
| Knowledge Explorer/revision diff/evidence UI | Target UI not proven by backend fixtures | #33 browser-level acceptance |
| Honcho interoperability | Historical SPEC section15 is an unproved tier-1 claim; no revision hash coupling | #8 real target deployment identity + export/import test, no reliance on dead endpoint |
| Copy migration and release | No live activation/migration authorized | #34 non-destructive rehearsal, compatibility and deployment checks |
| Serena / CodeGraph | Native MCP bridge calls succeed; refreshed source index | #37 tooling evidence; neither call-graph counts nor connectivity proves product behavior |

## Next gates, without changing scope

1. Verify the dispatched #24 store-boundary repair (required scope before storage/model access); retain fixture-limited redaction wording. Inventory is complete, acceptance is not.
2. Finish #23 source-ingestion/legacy-adapter decisions and explicit enforcement ownership. Do not leave stale codec notes claiming the accepted target registry is absent.
3. Review #25 authentication and #26 persistence contracts before implementing their service guarantees. Neither is supplied by RFC8785 or a single-writer comment.
4. Deliver #27-#34 through bounded slices against the shared service, rather than creating independent MCP-only behavior.

#23 remains open: its remaining decisions are not satisfied by passing the physical and byte fixtures. Every later issue remains independently subject to its acceptance criteria. PR #1 is historical and unchanged; replacement/merge decisions are separate from local acceptance.

## Latest verification scope

At `6289311`: root stable-tree Python discovery 79 tests; Bun full app/CLI suite 124 tests /1177 assertions; strict TypeScript, build, owned-file Ruff, Python compilation and whitespace checks passed. Root verified all 22 committed blobs match acceptance hashes. Whole-tree lint is not claimed clean. No push, release, production authorization or service-invariant proof is claimed.

See [#23 acceptance](https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/23#issuecomment-5749679095) and [commit verification](https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/23#issuecomment-5749690873).
