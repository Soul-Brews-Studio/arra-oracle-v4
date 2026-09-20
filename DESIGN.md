> Working design based on [discussion #36](https://github.com/Soul-Brews-Studio/arra-oracle-v4/discussions/36), with the explicit #23 candidate-contract refinements linked below applied to the relevant ASCII boxes and publication sequence. The original discussion remains the historical revision-2 snapshot. Built-state sections record publication-time evidence, not later patches. For running instructions see [app/README.md](app/README.md); release completion still requires [roadmap #22](https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/22). Candidate physical fixtures do not complete #23 or activate migration.

> Candidate implementation addendum: [target-v1 decisions](app/docs/contracts/target-v1-decisions.md) refines revision association authority and physical fixture gates for isolated #23 work; it is not runtime activation or #23 completion.

> Accepted isolated contract: [revision/evidence v1](app/docs/contracts/revision-evidence-v1.md) pins complete snapshots, typed evidence keys, RFC8785 bytes and fail-closed Python/Bun batch validation. Python still owns physical schema. The isolated codecs were accepted at `6289311`; this is not proof that new MCP features are shipped. Honcho tier-1 interoperability remains a separate unproved #8 gate.

> Current delivery overlay: [delivery gates](app/docs/contracts/delivery-gates.md) records accepted isolated physical/byte/source contracts through `33e3c44` and the scoped-read repair `7dd21d0`, remaining enforcement owners and unchanged runtime boundaries. Earlier built-state snapshots below remain historical.

# v4 revised full design: conversation, knowledge, context, and LanceDB

<!-- arra-v4:full-revision-after-honcho:2026-09-20 -->

**2026-09-20 — revision 2 plus reviewed #23 candidate-contract clarifications. Design and isolated fixture work, not completed runtime implementation.**

Python owns the schema. TypeScript owns the application. LanceDB stores our content and derived search data. Keep local storage as the default; R2 is optional. The content model remains simple: **title, body, fields, dates, taxonomy, and revisions**.

## What changed in this revision

Complete revision of #21 incorporating #35. The target remains 19 tables; context, representations and evidence traversal are service views, not new registries.

```text
PRESERVE                            ADD / CLARIFY
--------                            -------------
Python schema + TS application      Messages -> knowledge -> context loop
LanceDB; local first                 Explicit live-capture / Relic boundaries
One node + immutable revisions      Search != context != representation != chat
One taxonomy; flat type              Author / observer / subject end-to-end
Flat corrections + retirement       Source premises + reverse dependents
Derived search, save-first           Freshness, partial coverage, token budgets
15 built tables / 19 proposed        Connected MCP != finished product
```

## 0. Continue the design history

- [#14 — original full ASCII schema](https://github.com/Soul-Brews-Studio/arra-oracle-v4/discussions/14)
- [#16 — first compiled LanceDB schema](https://github.com/Soul-Brews-Studio/arra-oracle-v4/discussions/16)
- [#17 — measured runtime and storage boundaries](https://github.com/Soul-Brews-Studio/arra-oracle-v4/discussions/17)
- [#18 — specification versus implementation](https://github.com/Soul-Brews-Studio/arra-oracle-v4/discussions/18)
- [#19 — flat corrections and short/long-term classification](https://github.com/Soul-Brews-Studio/arra-oracle-v4/discussions/19)
- [#20 — conversation, knowledge entities, and ten Relic journey passes](https://github.com/Soul-Brews-Studio/arra-oracle-v4/discussions/20)

- [#21 — preceding complete 19-table design](https://github.com/Soul-Brews-Studio/arra-oracle-v4/discussions/21)
- [#35 — Honcho MCP capability gaps](https://github.com/Soul-Brews-Studio/arra-oracle-v4/discussions/35)
- [#22 — implementation roadmap, #23–#34](https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/22)

Preserves historical discussions. No generic entity/type/binding registry or full dreamer. Field-level proposals are not previously agreed or implemented contracts.

```text
HISTORY / EVIDENCE

53a8949c  ->  Honcho-inspired core and v4 schema
89094970  ->  LanceDB POC; Rust migration replaced by Python models
2762e4e7  ->  measured embedding/storage behavior; Elysia MCP
     |
     +--> #14 / #18: baseline and implementation drift
     +--> #19: flat corrections; memory horizon is classification
     +--> #20: journey evidence; revisionable knowledge
     +--> #21: simpler consolidated node design
01a0ba49 -> current Codex design / CLI / MCP / Honcho review
01a0bcc0 -> related verification buddy, NOT a continuation edge
     +--> #35: conversation-to-knowledge capability gaps
     +--> THIS: full revised design + current evidence

Foreign session 2bb9b553 is NOT part of this worktree's design chain.
Relic source bank != v4 workspace/bank.
```

Earlier Relic read: last Claude transcript 574 parsed events versus 539 indexed. Later 18:16 decisions—not the 14:05 handoff—record sync fixes, binary activity and eight-tool MCP.

### Latest-session recovery in this pass

Ran `relic sessions/search/session/pending/read`. Indexed results contained 19 logical entries / 49 transcripts, including vault records—not 19 conversations. The current Codex transcript was unindexed; `relic read` recovered its later design, tests, CLI, MCP and Honcho discussion directly. No reindex.

```text
RELIC RECOVERY: source IDs and useful displayed event positions
01a0ba49-ac87-7fe1-ad40-eabad2251883  current Codex thread
  #1295  prior full ASCII design
  #1411  issue roadmap published
  #1964  initial CLI delivered
  #2056  five CLI smoke/build checks; NOT full regression coverage
  #2259  native v4 MCP connected and read-only calls succeeded
  #2333  Honcho gaps / context-first recommendation

01a0bcc0-134b-7133-a784-b80d987aed36  verification buddy
  #274   45 bounded commands; service checks 11 pass / 8 fail
  #282   no product changes, no PR, contract #23 still incomplete
```

Positions locate this capture, not immutable cross-capture identities. Foreign Ansible remains excluded. This pass did not reread all 44 origin agents or all Big Boss history. Earlier Rust/libSQL proposals do not override Python/LanceDB.

## 1. What is built, chosen, proposed, or still open?

```text
[B] BUILT BASELINE at spike commit 71bc1d6
    Python LanceModel declarations; 15 tables / 152 fields; memories=20
    Bun/Elysia HTTP + MCP; eight tools in source
    local LanceDB; optional R2 connection configuration
    ICU full-text search; nullable 384-d Ollama embeddings + backfill

[L] LOCAL ADDITIONS / CONNECTION, not a release
    CLI: 13 backend commands + help; uncommitted product changes
    Localhost-only server; isolated local dataset; v4 MCP connected
    Fresh native status reports 8 tools, local storage, auth absent
    Connecting MCP does NOT capture this conversation automatically

[D] DESIGN DIRECTION carried forward
    LanceDB as database; Python schema + TypeScript application
    local first; optional R2; save content before model work
    one node shape; immutable revisions; flat controlled type vocabulary
    tags/categories/horizon through the same taxonomy mechanism
    peers, session context, evidence, and explicit corrections

[P] PROPOSED BELOW, NOT YET IMPLEMENTED
    node/revision APIs and fields; revision-scoped taxonomy/evidence
    explicit session links; revision-aware derived search tables
    message ingestion + source mapping; context builder before chat
    evidence premises/dependents; representations as scoped read views
    peer-context chat; freshness/reporting; safe write protocol

[O] OPEN IMPLEMENTATION GATES
    concurrency/commit/recovery proof; auth and scope enforcement
    migration/backward compatibility; exact Arrow/API contracts
    Honcho compatibility round-trip; production deployment
```

Fresh native `status` confirmed connectivity, not every tool or embedding health. The earlier empty-bank read was a snapshot. Publishing this design performs no migration.

### Active schema inventory, not the obsolete Rust migrator

```text
CURRENT TABLE            FIELDS       CURRENT TABLE          FIELDS
-------------            ------       -------------          ------
workspaces                    7       supersede_log               13
peers                         7       traces                      22
sessions                      8       trace_hits                   7
session_peers                 7       mcp_calls                   10
messages                     15       connections                 12
memories                     20       read_cursors                 4
vocabularies                 10
terms                         8       TOTAL: 15 tables / 152 fields
memory_terms                  2

CURRENT memories (20)
id, name, workspace_name, session_name, peer_name, subject_peer_name,
type, content, embedding, created_at, valid_from, valid_to, sync_state,
last_sync_at, sync_attempts, superseded_by, superseded_at, is_active,
h_metadata, internal_metadata
```

Declaring peers/messages/taxonomy tables does not mean their APIs are implemented. `app/migrate-py/src/arra_migrate/models/__init__.py` is the active registry; the older Rust schema is not the baseline.

### Verification status carried forward, not misreported as all-pass

- Isolated migration + 16 IPC fixtures passed (15/152 schemas), not the future revision protocol.
- Service probes: **11 pass / 8 fail**: save-first, vectors, call ordering/scope/attribution, audit and HTTP BigInt failures. Separate profile-mismatch probe also failed.
- No checked-in Python/Bun regression suite then; lint: 12 findings; historical Rust builds timed out. Reproducing defects is not conformance.
- CLI: **5/5 smoke/type/build**, no live integration coverage. CLI/localhost edits are uncommitted and do not fix these defects.
- Authentication is absent. Localhost reduces exposure but is not authorization. Do not deploy this spike as a shared service.

## 2. One-screen full map

```text
HUMAN / AGENT
    |
    +---- Web UI ---- CLI ---- MCP ---- HTTP API
                          |
                          v
                TYPESCRIPT / BUN / ELYSIA
                authorize -> validate -> execute -> audit
                          |
                          v
+-------------------------------------------------------------------+
| WORKSPACE / BANK                                                  |
| One isolation boundary. `bank` is the API alias of workspaces.name. |
|                                                                   |
|  PEERS                           TAXONOMY                          |
|  human / agent                   vocabularies -> terms             |
|      |                              |                             |
|      +--> SESSION_PEERS             +--> type: exactly one         |
|                |                    +--> topics: many              |
|                v                    +--> category: configured      |
|             SESSIONS                +--> memory_horizon: 0..1      |
|                |                              |                   |
|                +--> ordered MESSAGES          |                   |
|                +--> SESSION_LINKS             |                   |
|                          |                    |                   |
|                          v                    v                   |
|  TRACES -----------------------> NODES -> NODE_REVISIONS           |
|    |                              |         |                     |
|    +--> TRACE_HITS                |         +--> REVISION_TERMS    |
|    +--> previous / parent trace   |         +--> REVISION_LINKS    |
|                                   |              |                |
|                                   |              +--> evidence    |
|                                   |              +--> corrects    |
|                                   |              +--> discusses   |
|                                   |                               |
|                                   +--> SUPERSEDE_LOG               |
|                                                                   |
|  DERIVED SEARCH                                                   |
|  SEARCH_CHUNKS_V1 -> text / vector / scope / revision / state       |
|                                                                   |
|  OPERATIONS                                                       |
|  MCP_CALLS / CONNECTIONS / READ_CURSORS                             |
+-------------------------------------------------------------------+
                          |
             +------------+-------------+
             |                          |
             v                          v
        local files                  R2 objects
          DEFAULT                    OPTIONAL

EXTERNAL EVIDENCE, not another copy of every transcript:
Relic sessions / source excerpts / Git commits / code paths / issues
```

Messages record what was said. Traces record what was investigated. Nodes record what we want to preserve. A conclusion is a node of type `conclusion`, not a second knowledge database.

### Left-to-right product loop

```text
Explicit capture        Preserve / review        Assemble         Use
----------------        -----------------        --------         ---
Human/agent messages -> Sessions + peers -----> get_context ----> Any assistant
                                      \            ^
Relic read-only -------> Pinned evidence -> Nodes/revisions -----+
                                      /             |          |
Investigation --------> Traces/hits -----------------+          +-> Peer chat
                                                    |
                                         Search chunks + indexes
                                           derived, rebuildable
```

Capture is an explicit integration. Knowledge creation is a separate action. Context is a read operation. Chat is an optional model operation. None silently implies the others.

## 3. Runtime and ownership

```text
PYTHON                                      TYPESCRIPT
------                                      ----------
LanceModel declarations                     Bun + Elysia service
schema registry                             HTTP / MCP / CLI / UI
table creation / migration                  request validation
Arrow type + nullability checks             permissions + scope
schema version                              content/revision writes
                                            retrieval + chat orchestration
          |                                           |
          +--------- versioned contract ---------------+
                              |
                              v
                           LANCEDB
                 canonical rows + derived tables

BACKGROUND WORK, separate from the content-save critical path
  text chunking -> embeddings -> reconciliation/retry
  optional explicit conclusion extraction/summarization

CURRENT EMBEDDER: local Ollama, called from TypeScript.
PYTHON MODEL WORKER: optional if we choose Python-hosted models later.
No Python subprocess is required for every CRUD request.
```

TS type/runtime-schema generation remains proposed. Python declarations do not enforce app validation, authorization, relations or transactions. Neither runtime may infer schema from its first inserted row.

Honcho's Python/FastAPI + PostgreSQL implementation is a reference, not our backend. We borrow its core entities and peer-perspective semantics; we are not promising its complete automatic derivation/dreaming system.

## 4. Schema conventions and inventory

```text
W          workspace_name; present on each proposed scoped table
ID         opaque stable identifier, never authorization
REF        validated reference within W unless explicitly external
?          nullable / optional
JSON       validated document; current spike often stores JSON as text
TIME       UTC instant; display may use Asia/Bangkok

NEW timestamp encoding must be pinned in the Arrow contract.
Do not silently reinterpret legacy epoch milliseconds as microseconds.
PK / UNIQUE / REF below are REQUIRED LOGICAL INVARIANTS.
They are NOT claims that LanceDB enforces SQL foreign keys.
```

Target: **19 logical tables**, replacing/extending the 15-table baseline; not an instruction to create them now.

```text
CORE (5)                CONTEXT (1)           KNOWLEDGE (5)
workspaces              session_links        nodes
peers                                        node_revisions
sessions                                     node_revision_terms
session_peers                                revision_links
messages                                     supersede_log

TAXONOMY (2)            INVESTIGATION (2)     SEARCH (1)
vocabularies            traces               search_chunks_v1
terms                   trace_hits

OPERATIONS (3)
mcp_calls
connections
read_cursors
```

Auth `tokens`/`oauth_clients` need separate contracts; `delivery_refs` is deferred. No implicit queue/job framework.

## 5. Core: preserve the five Honcho-shaped entities

Core fields reflect existing declarations, with [P] additions. Honcho interchange still needs export/import tests.

```text
+-- workspaces -----------------------------------------------------+
| id                     ID                                        |
| name                   stable workspace key                      |
| created_at             TIME                                      |
| h_metadata?            JSON                                      |
| internal_metadata?     protected JSON                            |
| configuration?         JSON                                      |
| mission?               text; v4 additive field                   |
| UNIQUE(name); API bank resolves to name                           |
+------------------------------------------------------------------+

+-- peers ----------------------------------------------------------+
| id, name, workspace_name                                         |
| h_metadata?, internal_metadata?, configuration?                  |
| created_at                                                       |
| UNIQUE(W, name)                                                  |
+------------------------------------------------------------------+

+-- sessions -------------------------------------------------------+
| id, name, workspace_name, is_active                               |
| h_metadata?, internal_metadata?, configuration?                  |
| created_at                                                       |
| UNIQUE(W, name)                                                  |
+------------------------------------------------------------------+

+-- session_peers --------------------------------------------------+
| workspace_name, session_name, peer_name                           |
| configuration?, internal_metadata?                               |
| joined_at, left_at?                                              |
| UNIQUE(W, session_name, peer_name)                                |
| REF session and peer inside the same W                           |
+------------------------------------------------------------------+

+-- messages -------------------------------------------------------+
| id                     legacy integer identity                   |
| public_id              stable external message handle            |
| workspace_name, session_name, peer_name                           |
| content, token_count, seq_in_session                              |
| h_metadata?, internal_metadata?, created_at                       |
| role?, in_reply_to?, read?, read_at?    v4 additive fields         |
| source_namespace?, source_message_id?                    [P]      |
| source_payload_digest?, source_created_at?               [P]      |
| ingested_at                                              [P]      |
| Source key/digest all present or all absent; source time nullable |
| UNIQUE(W,source_namespace,source_message_id) when source provided |
| UNIQUE(W, session_name, seq_in_session)                           |
| UNIQUE(W,public_id); legacy collisions need explicit migration map |
| in_reply_to must resolve in the permitted conversation scope     |
+------------------------------------------------------------------+
```

Peer registration grants no access. Never auto-merge `Neo`, `neo`, `neo-oracle`; aliases require explicit identity decisions.

`messages.read/read_at` are legacy fields, not a per-reader truth. For multiple readers use `read_cursors`; do not pretend one boolean describes everybody.

### Session names, original IDs, and chains

```text
Local session
  name = stable v4 handle
  display title = optional metadata, not another mutable identity
  external reference = namespaced Relic session ID in metadata

Relic reference
  source_bank + provider + session_uuid
  source capture/digest when citing specific content

+-- session_links [P] -----------------------------------------------+
| id, W                                                            |
| from_session_name        later session / child                    |
| to_session_name          earlier session / parent                 |
| relation                 continues | forked_from | related_to     |
| evidence_ref?            typed external locator / capture         |
| created_by_peer_name?, created_at                                 |
| Same W; no self edge; no cycles for continues/forked_from         |
+------------------------------------------------------------------+

S3 --continues--> S2 --continues--> S1
SA --forked_from------------------> S1
```

Temporal proximity suggests a possible continuation; it does not prove one. A cwd move does not transfer session ownership. External references must not silently import a foreign session or bridge workspaces.

### Message capture and Relic adapter boundary [P]

```text
LIVE OPT-IN ADAPTER                         HISTORICAL RELIC ADAPTER
register/resolve peers                     discover indexed + pending
resolve explicit session                   read chosen session/capture
append attributed message batch            select bounded source excerpt
          |                                           |
          v                                           v
     v4 messages                            trace hit / revision link
     append-only facts                      pinned digest + namespace
          |                                           |
          +--------------- optional review -----------+
                              |
                        conclusion revision
```

Preserve speaker, source order/identity. Proposed columns above pin source identity/digest and distinguish nullable source time from required server ingestion time; legacy `created_at` conversion stays explicit. Namespace includes provider/account/session when IDs are not global. Hash a versioned canonical source payload (speaker/content/source time), excluding ingestion time. Exact replay returns the prior result; changed-payload replay conflicts. Source identity, digest and pure replay mapping are defined by the accepted #23 contracts. Single-writer uniqueness, sequence allocation and per-item durable batch acknowledgment remain **#26/#28 service proof gates**.

Connector principal is not speaker identity. Unknown/imported speakers stay unknown until mapped. Validate source mappings in existing metadata before considering a new registry.

Cite Relic by default; explicit selected imports preserve provenance, idempotency and original time separately from ingestion order. Source banks are not authorization scopes; shared cwd does not justify importing Ansible.

## 6. Knowledge: one node shape, immutable revisions

```text
+-- nodes [P] -------------------------------------------------------+
| id, workspace_name                                               |
| current_revision_id       accepted current revision of THIS node |
| created_at                                                       |
| updated_at                current-view timestamp                 |
| PK(W,id); head reference must match W AND node_id                 |
+-----------------------------+------------------------------------+
                              | 1 : many
                              v
+-- node_revisions [P] ----------------------------------------------+
| id, W, node_id, revision_no                                       |
| base_revision_id?         expected previous accepted revision    |
| operation_id              retry/idempotency key                  |
| title, body, body_format                                         |
| fields                    validated extension JSON               |
| author_peer_name?         who wrote this revision                 |
| observer_peer_name?       whose understanding it represents       |
| subject_peer_name?        who it is about                         |
| session_name?             optional local context, not all evidence|
| is_active                 explicit active/inactive decision       |
| valid_from?, valid_to?    statement validity, not retention tier   |
| change_reason?, created_at                                       |
| schema_version, canonical_version, content_digest                |
| term_snapshot_json        complete canonical term array          |
| link_snapshot_json        complete canonical evidence array      |
| h_metadata?, internal_metadata?                                  |
| Ordinal belongs to accepted ancestry, not global row uniqueness  |
| UNIQUE(W,operation_id) within revision operations: service gate   |
+------------------------------------------------------------------+

Node N1
  +-- R1: initial understanding
  +-- R2: improved explanation
  +-- R3: added evidence / changed taxonomy  <-- current

One revision owns complete immutable term/link snapshots in its row.
Association meaning is immutable; query projection rows are rebuildable.
```

Digest covers canonical content, governed fields and complete term/link snapshots. Canonical byte validation was accepted in the isolated [revision/evidence contract](app/docs/contracts/revision-evidence-v1.md) at `6289311`; durable publication remains #26. The required snapshot columns and canonical version are the [candidate physical refinement](app/docs/contracts/target-v1-decisions.md); physical shape alone is not byte-validation proof. `node_revision_terms` and `revision_links` are derived projections, not separate association authority or publication prerequisites. Unchanged text may reuse compatible vectors without merging revisions.

No table per type. Do not hide identity/permissions/perspective/evidence in `fields`. Type behavior requires explicit validators, not just labels.

### Three people-shaped roles, not one

```text
author    = claude   wrote the revision
observer  = neo      understanding is attributed to Neo
subject   = nat      conclusion concerns Nat

Conclusion about a repository?
  subject_peer = NULL; cite the repo/code evidence instead.
  Do not invent a fake peer for a repository.
```

Unknown attribution stays unknown. Principal/user-agent belong to audit, not automatically author/observer/subject.

## 7. Type, tags, categories, and memory horizon: one taxonomy

```text
VOCABULARY              TERMS                      POLICY
----------              -----                      ------
type                    note                       exactly one
                        conclusion                 flat
                        learning                   controlled
                        discussion                 extend by admin API
                        correction

topics                  schema, oracle, honcho     zero or many
                                                   open or controlled

category                engineering, personal     configured 0..1/many
                                                   flat or hierarchical

memory_horizon          short_term, long_term      zero or one
                                                   flat, controlled

Content type = what kind of node?
Taxonomy     = the mechanism for classifying nodes.
Vocabulary   = a named group with policies.
Term         = one value within that group.
```

`type` is a reserved vocabulary, not a language enum and not a second registry. Creating a type creates an authorized term in that vocabulary. The API may offer `type: "conclusion"` as input sugar, but the assignment is stored once.

```text
+-- vocabularies [existing, proposed policy additions] ---------------+
| id, W, name, label, description?                                  |
| kind                     tags | categories (existing convention) |
| term_policy              open | sealed                           |
| cardinality              one | many                    [P]       |
| required                 boolean                       [P]       |
| hierarchy                flat | tree                   [P]       |
| h_metadata?, internal_metadata?, created_at                       |
| UNIQUE(W,name)                                                   |
+-----------------------------+------------------------------------+
                              | 1 : many
                              v
+-- terms [existing, W proposed explicitly] -------------------------+
| id, workspace_name, vocabulary_id                                |
| name, description?, parent_id?, weight                            |
| is_active                prevent new assignments       [P]       |
| h_metadata?, created_at                                          |
| UNIQUE(W,vocabulary_id,name); parent in SAME vocabulary           |
| Flat vocabularies reject parent_id; trees reject cycles           |
+-----------------------------+------------------------------------+
                              |
                              v
+-- node_revision_terms [P; derived query projection] ---------------+
| W, revision_id, term_id                                          |
| vocabulary_id            validated owner, not alternate authority|
| vocabulary_name_snapshot, term_name_snapshot, label_snapshot?     |
| position                                                          |
| UNIQUE(W,revision_id,term_id)                                     |
| Whole revision: exactly one type; at most one memory_horizon      |
+------------------------------------------------------------------+
```

`cardinality=one` means maximum one; `required=true` makes it exactly one. Ordinary new nodes default to the seeded `note` term if type is omitted. The horizon remains unclassified unless explicitly assigned; legacy memories are not silently promoted to long-term.

Sealed blocks ordinary term creation; authorized vocabulary admins may extend `type`. Labels install no executable behavior. Cardinality/hierarchy/creation are independent.

Term IDs retain meaning; rename is not repurposing. Retire referenced terms; old revisions retain label snapshots, not full taxonomy-definition history (deferred).

```text
Short-term -> long-term = new revision changing classification
Short-term != wrong     Long-term != verified
Horizon    != expiry    Horizon   != access permission
No popularity decay or write-on-every-recall loop implied.
```

## 8. Evidence and links: many sources per conclusion

```text
+-- revision_links [P; derived query projection] --------------------+
| W, revision_id, position                                         |
| relation                 supports | contradicts | derived_from   |
|                          discusses | corrects | related_to       |
| target_kind              node_revision | trace | message         |
|                          session | relic_event | relic_session   |
|                          code | commit | issue | discussion | url|
| target                   validated discriminated JSON            |
| target_key               versioned canonical locator digest [P]  |
| excerpt?                 bounded captured evidence               |
| content_hash?            digest of captured evidence              |
| captured_at?, capture_status                                     |
| note?                                                           |
| KEY(W,revision_id,position); no independent random id             |
| Meaning pinned by revision snapshot; physical rows rebuildable   |
| All internal targets scoped by W                                |
+------------------------------------------------------------------+
```

For `supports`/`contradicts`, the **target evidence supports or contradicts the owning revision**. For `corrects`, the owning revision corrects the target. For `derived_from`, the owning revision derives from the target. These meanings are not interchangeable arrows.

```text
TYPED TARGETS: not arbitrary bags of unrelated fields

node_revision { node_id, revision_id }
trace         { trace_id }
message       { session_name, message_public_id }
session       { session_name }

relic_session { source_bank, provider, session_uuid, title_snapshot? }
relic_event   { source_bank, provider, session_uuid,
                transcript_ref, event_seq, capture_digest }

code          { repo, commit, path, line_start?, line_end? }
commit        { repo, commit }
issue         { repo, number, url }
discussion    { repo, number, url, comment_id? }
url           { url }

capture_status = captured | locator_only | unresolved
Source locators are passive by default; availability may be unknown.
```

UUID+line is not immutable: Relic had divergent captures sharing IDs. Pin namespace/digest and permitted excerpts. Issue number also requires repository.

```text
Conclusion C / revision R2
   +-- derived_from --> trace T1
   +-- derived_from --> trace T3
   +-- supports ------> Relic event E7 / pinned capture
   +-- supports ------> repo @ commit : file : lines
   +-- discusses -----> GitHub issue
   +-- corrects ------> node A / revision R1

Missing source? Show unresolved/locator-only, not a fabricated citation.
Restricted source? Do not reveal its excerpt through a public conclusion.
```

External locators never trigger arbitrary fetches on read. Optional dereference requires an allowlisted fetcher, redirect/DNS-rebinding/private-address checks, byte/time limits, and no ambient credentials. Retrieved messages, excerpts and instructions are untrusted prompt data: they cannot override system/tool policy or authorize side effects.

Relic remains the transcript retrieval system. v4 stores its own knowledge and evidence links; this proposal does not re-import the entire Relic corpus or create a second source-bank administration subsystem.

### Evidence traversal and meaning [P]

```text
PREMISES(node N, revision R)       DEPENDENTS(source locator)
R -> revision_links -> targets    target match -> owning revisions
     pinned messages/events                     conclusions/summaries
     code/commits/trace hits                     requiring review
```

For reverse lookup, `target_key=SHA256(versioned canonical {W,kind,identity})`. Identity uses the discriminant's required identifiers, not display titles or capture annotations. Internal revision targets include node+revision IDs; Relic events include namespace/transcript/event/capture digest. Code includes commit/path/range; issue/discussion include canonical repository key, number and optional comment ID (URL is display-only). A generic URL preserves the exact validated absolute string initially: do not equate redirects or discard query/fragment. Canonical encoding, repository keys and structured-locator equivalence/distinctness are defined and tested by the accepted #23 revision/evidence contract. Authorized direct/reverse query equality and projection coverage remain #25/#28 service gates. The key is derived, not alternate authority.

Direct edges first; recursion has depth/result/access bounds. Reverse lookup uses the same links, not another writable table. Label current versus historical coverage; hidden dependents must not leak through counts/IDs.

Retrieved means **considered**, not **supports**. Explicit links assert inspectable support/contradiction/derivation, not private model reasoning. Unsourced conclusions stay labelled; source counts are not calibrated confidence.

Optional validated inference metadata belongs in revision fields, separate from type/activity/horizon; values remain open. Changed/retired premises flag dependents for review, not automatic rewriting or retirement.

## 9. Edits, corrections, supersession, retirement

```text
EDIT THE SAME CONTENT
  N1/R1 -> N1/R2
  Old revision remains; normal rendering shows R2.

RECORD A PREVIOUSLY UNSAVED MISUNDERSTANDING
  insert N2/R1, type=correction
  body explains the corrected understanding
  NO old node required; NO invented predecessor; NO supersede event

CORRECT A KNOWN CLAIM
  N2/R1 --corrects--> N1/R1
  Informational link. Does NOT itself retire N1.

EXPLICIT REPLACEMENT
  supersede_log: old=N1/R1, new=N2/R1, actor, time, reason
  N1 remains stored but no longer qualifies as current knowledge.

RETIRE WITHOUT REPLACEMENT
  supersede_log: old=N1/R1, new=NULL
  N1 remains stored; no replacement pointer is required.
```

```text
+-- supersede_log [existing, proposed revision/idempotency additions] -+
| id, W                                                            |
| old_id, old_revision_id                                  [P]      |
| old_title?, old_type?, old_source?                                |
| new_id?, new_revision_id?                                [P]      |
| new_title?, new_source?                                          |
| reason, peer_name?, superseded_at                                 |
| operation_id                                             [P]      |
| h_metadata?                                                      |
| UNIQUE(W,operation_id), enforced by the serialized writer         |
| Append-only; old/new must be same W; new pair null means retire   |
+------------------------------------------------------------------+
```

The event targets the node as the retired/replaced identity; revision IDs pin the compared versions. An ordinary edit must not accidentally reactivate a retired node. An explicit restoration/reversal operation is deferred until its append-only semantics are specified.

No nested correction tree; history remains traversable without replaying ancestors to read the latest node. Reject self/cyclic/conflicting replacements. One effective replacement per old node; projections rebuild from accepted events.

```text
NORMAL RECALL ELIGIBILITY
  authorized workspace
  AND accepted current revision
  AND revision.is_active
  AND within valid_from / valid_to when present
  AND not explicitly replaced or retired

History mode may show older/inactive/replaced material, clearly labelled.
`new_id IS NULL` is NOT enough to identify an active node.
```

## 10. Traces: investigation and journey, not another conclusion copy

```text
+-- traces [existing, revised result linkage] -----------------------+
| id, name, W, session_name?, peer_name?                            |
| query, mode?                                                     |
| session_id?, session_from_ts?, session_to_ts?                     |
| friction_score?, confidence?                                     |
| parent_id?               causal parent trace                     |
| prev_id?                 previous trace in a readable sequence    |
| depth                    derived/cache, not another edge         |
| status                   raw | reviewed | distilled | retired    |
| h_metadata?, internal_metadata?, created_at, updated_at           |
| Parent/previous targets same W; cycle checks                      |
+-----------------------------+------------------------------------+
                              | 1 : many
                              v
+-- trace_hits [existing, structured target/capture additions] -------+
| W, trace_id, position                                             |
| kind                     same typed evidence target kinds        |
| ref                      existing locator, compatibility         |
| target                   validated locator JSON         [P]       |
| line_start?, line_end?, note?                                    |
| excerpt?, content_hash?, captured_at?                    [P]       |
| Trace belongs to same W; no unscoped lookup                       |
+------------------------------------------------------------------+

T1 --next (reverse prev lookup)--> T2 --> T3
 |                                |      |
 +--> Conclusion A               +----> Conclusion B
                                   cites both T2 and T3
```

`traces.distilled_to/distilled_at` in the old model cannot represent many conclusions per trace. The proposed canonical result linkage is `revision_links(relation=derived_from, target_kind=trace)`; a compatibility display may derive the old singular view, but must not silently discard additional conclusions.

`session_id` on old traces must be namespaced as an external source reference when applicable; it is not interchangeable with local `session_name`. No duplicated `next_id` or child-ID array needs to become another writable edge authority.

## 11. Embeddings: a rebuildable search table in the same database

```text
AUTHORITATIVE                         DERIVED / REBUILDABLE
nodes + revisions                     search_chunks_v1
revision term/link snapshots          association projections + FTS
sessions + messages                   vector index
traces + supersede log                 filter metadata projections

Rebuilding vectors must not rewrite or delete knowledge history.
```

```text
+-- search_chunks_v1 [P] --------------------------------------------+
| id, W                                                            |
| node_id, revision_id, chunk_index                                 |
| text                     exact prepared text                     |
| content_hash, chunker_version                                    |
| embedding_profile        model/version/input rules/dimension     |
| embedding?               FixedSizeList<Float32,D>                 |
| type_term_id, term_ids    copied filtering metadata               |
| observer_peer_name?, subject_peer_name?, session_name?           |
| status                   pending | ready | failed                |
| attempts, last_attempt_at?, embedded_at?, error_code?             |
| Deterministic identity from W/revision/profile/chunk              |
+------------------------------------------------------------------+

one embedding profile per physical table
  v1 / profile A -> D dimensions
  v2 / profile B -> D2 dimensions

Same dimensions do NOT make two model profiles compatible.
Query embedding profile must match stored vectors.
```

Profiles pin model/version/digest, dimensions, normalization and query/document prefixes. Model changes rebuild search, not history. Tag-only revisions may reuse compatible text/profile vectors but keep their own search rows.

```text
SAVE PATH
  validate + authorize
          |
          v
  persist complete revision row with term/link snapshots
  publish verified head (#26 proof gate)
          |
          +--> acknowledge durable content
          |
          +--> rebuild association query projections
          |
          v
  prepare chunk text / make keyword index eligible
          |
          v
  embedding work ----failure----> failed/pending + retry policy
          |
          v
        ready

RECONCILIATION
  accepted revisions expected to be searchable
     MINUS complete matching search chunks
     = missing / stale / unfinished work
```

Content becomes durable before any model call. Keyword search becomes available when chunk/index preparation completes; the API must not promise it is instant if that work is asynchronous. Semantic search may be incomplete and must say so.

Single-writer reconciliation recovers even absent chunks without a queue database. Multiple workers require a proven claim/lease protocol.

Use ICU FTS as the measured baseline, with phrase/AND behavior and English stemming/stop-word choices tested against real Thai/English data. Keep keyword and semantic modes explicit; do not assume hybrid fusion improves them. The old 25-row probe is not a universal benchmark.

After retrieving candidates, authorize and validate the authoritative current revision, activity, validity, and supersession state. Copied search filters are optimization, not permission or truth. Overfetch/refill must be bounded and expose partial coverage rather than quietly return stale results.

## 12. Context first, then peer-aware chat and the review UI

### Four separate read/model operations [P]

```text
SEARCH          query -> ranked matching records + source IDs
CONTEXT         scope + budget -> ready-to-use evidence bundle
REPRESENTATION  observer + subject -> selected knowledge view
CHAT            question + context -> model answer + citations
```

Honcho's context and directional representation surfaces motivate these distinctions, not a backend switch. See [Get Context](https://honcho.dev/docs/v3/documentation/features/get-context) and [directional representations](https://honcho.dev/docs/v3/documentation/features/advanced/directional-representations).

```text
get_context(
  bank, session_names OR bounded chain request,
  observer_peer_name?, subject_peer_name?, query?, token_budget
)
  |
  +-- resolve explicit permitted sessions and membership
  +-- select recent messages + eligible current conclusion revisions
  +-- include eligible stored summary if present (otherwise null)
  +-- resolve source references, apply access/lifecycle checks
  +-- budget, deduplicate, order, return coverage information

RESPONSE CONCEPT
  scope: requested + effective sessions; observer; subject
  messages: attributed records, original order, stable IDs
  conclusions: node/revision IDs, text, perspective, source handles
  summary: null OR sourced saved revision (not made up on every read)
  sources: bounded evidence objects and capture status
  budget: limit, estimate/actual, tokenizer identity, truncation
  freshness: assembled_at, source/index watermarks, pending/failed
  coverage: omitted/truncated/unresolved/inaccessible material flags
```

Pin tokenizer/budget rules: reserve framing, reject invalid limits, use deterministic ranking/deduplication. Disclose estimates and conservative truncation; never claim exact tokens without a tokenizer. `summary:null` does not imply no history. Protected sources may yield a coarse incomplete flag, never leaked counts/IDs.

Context reads do not call models, mark read or mutate knowledge; audit is separate. Return watermarks or `unknown`: assembly time is not an atomic snapshot. Index lag, missing vectors and missing evidence are different.

### Peer representation without more core tables [P]

Compute `observer -> subject` from scoped eligible conclusions. Curated peer cards may be governed nodes; caches carry scope/profile/source watermarks. No new `peer_cards` table; never merge all observers/workspaces into a global profile.

Saved summaries are revisionable nodes with pinned sources; a `summary` term is a seed choice, not a table. Optional extraction first needs eligibility, attribution, review, retry and model-cost policies.

### UI and chat behavior

```text
+------------------------------------------------------------------+
| WORKSPACE: neo                                                   |
|                                                                  |
| Peers                  Sessions                                  |
| nat                    schema-design                             |
| neo                    runtime-spike                             |
| claude                 [show continuation / fork links]          |
|                                                                  |
| [Conclusions] [Chat] [Messages] [Traces] [History] [Configuration]  |
|                                                                  |
| About peer: [nat / any]     Observer: [neo / any]                  |
| Author: [any]              Session: [one / permitted chain / all] |
| Type: [conclusion]         Topics: [schema]                       |
| Horizon: [any]             Search: [keyword / semantic]          |
|                                                                  |
| Conclusion title                                                 |
| body...                                                          |
| by author / observer / about peer                                 |
| [Sources] [Trace] [Revisions] [Diff] [Correct] [Supersede]          |
+------------------------------------------------------------------+

QUESTION
  -> authorize requested workspace + context
  -> resolve selected peer/session/chain filters
  -> retrieve text or vector candidates
  -> validate current revision + permissions + provenance
  -> build bounded context
  -> chat model returns answer with source links
```

Chatting with Neo's recorded understanding is not contacting a live Neo agent. A chain filter is an explicit expansion over permitted linked sessions, not a default widening to foreign sessions or all workspaces.

```text
Ask a question                 does not automatically create a node
Save the exchange              explicitly append session messages
Save a conclusion             explicitly create a conclusion node
Revise a conclusion           create a new immutable revision
Automatically extract later   optional feature; review policy required
```

Render current/exact revision/history/diff/evidence using stored content and label snapshots. Wall-clock "as-of" needs defined ordering/tie-breaks, not only timestamps.

### Freshness instead of a premature dreamer [P]

```text
Content committed: yes/no        message/source watermark
Text search: ready/partial       chunks expected vs eligible
Vectors: ready/pending/failed    profile, attempts, last progress
Summary: absent/current/stale    source revisions represented
Extraction: disabled/queued/...  only if an extractor is enabled
```

Unknown is not zero; do not combine unrelated stages into a fake completion percentage. Start with deterministic reconciliation, not a new queue/job/dreamer product. Honcho returned messages with `summary: null`; automatic summary/conclusion success was not demonstrated here.

## 13. Operations and audit

```text
+-- mcp_calls [existing, attribution clarification proposed] ---------+
| id, W, session_name?, peer_name?                                  |
| tool, status                  ok | error                         |
| duration_ms, created_at                                          |
| h_metadata?, internal_metadata?                                  |
| connection_id?, principal?                              [P]       |
| input/result summaries: redact secrets, then truncate at write    |
+------------------------------------------------------------------+

+-- connections [existing] -----------------------------------------+
| id, W, method, principal, label                                  |
| user_agent?, remote_ip?                                          |
| first_seen, last_seen, requests, tool_calls, last_tool?            |
| Operational identity; never store credentials here               |
+------------------------------------------------------------------+

+-- read_cursors [existing, corrected proposed scope] ----------------+
| W, peer_name, session_name                                       |
| last_read_message_id?, last_read_at                               |
| UNIQUE(W,peer_name,session_name)                                  |
| Referenced message must belong to that same W and session        |
+------------------------------------------------------------------+
```

Audit access requires authorization too. Listing "latest calls" means filter by permitted workspace, order the full eligible set by time with a stable ID tie-break, then limit. Do not limit first and sort the arbitrary subset.

Current source gaps observed at `71bc1d6`: `calls.recent` limits before sorting; MCP `call_log` and `call_stats` do not pass bank scope; caller user-agent is currently placed in `peer_name`; `bank_info` uses global store statistics. These are implementation gaps, not guarantees supplied by the proposed columns. Do not expose this spike as authenticated multi-tenant production.

## 14. API / CLI / MCP: one service contract

The first table contains **proposed** interface concepts. The current CLI/MCP inventory follows separately; do not copy a proposed command and assume it exists.

```text
HTTP                              CLI CONCEPT
----                              -----------
POST /api/banks/:bank/nodes        oracle node create
GET  /api/banks/:bank/nodes/:id    oracle node show
POST .../nodes/:id/revisions       oracle node revise --base REV
GET  .../nodes/:id/revisions       oracle node history
POST .../supersessions             oracle node supersede OLD --with NEW

POST .../vocabularies              oracle vocabulary create
POST .../vocabularies/:id/terms    oracle term create
                                   oracle type create conclusion
                                   = term create in reserved `type`

POST .../peers                     oracle peer register
POST .../sessions                  oracle session create
POST .../sessions/:name/messages  oracle message append
POST .../session-links             oracle session link
POST .../traces                    oracle trace create
GET  .../context                   oracle context --session S --tokens N
GET  .../representations           oracle peer context --observer neo --about nat
GET  .../nodes/:id/evidence         oracle node sources ID --revision REV
GET  .../dependents                oracle evidence dependents SOURCE
GET  .../processing-status         oracle status --processing
POST .../chat                      oracle chat --observer neo --about nat
GET  .../search                    oracle recall --mode keyword
```

MCP tools call the same validated service operations as HTTP and CLI, rather than implementing a separate set of rules. Keep current `remember`, `recall`, and memory-read tools as compatibility adapters when the node contract is ready. Adapters must preserve semantics, not merely rename a response.

```text
CURRENT MCP TOOLS (8)
remember / recall / get_memory / list_memories
bank_info / call_log / call_stats / status

CURRENT ROUTE
/mcp/:bank[/:workspace]

DESIGN RULE
bank = workspaces.name; no nested tenant invented by that spelling.
The current extra :workspace segment is ignored by dispatch.
Resolve/deprecate that ambiguity; do not claim it scopes a room today.
```

### Current executable surface (local additions)

```text
RUN: bun app/cli.ts <command> [options]
     or, from app/server: bun run cli <command> [options]

MCP-backed (8)                      HTTP-backed (5)
remember                            health
recall                              list
get-memory                          search
list-memories                       backfill
bank-info                           reindex
call-log
call-stats                          plus help / --help / -h
status

Options: --url, --bank, --pretty (plus command-specific options)
Environment: ARRA_URL, ARRA_BANK
Defaults: http://127.0.0.1:3939, bank=default
```

Source-run CLI, not an installed binary; no peer/session/node/context commands. HTTP POST memory creation and `/api/health` lack separate wrappers. Subject, strict flags and MCP `isError` exits need fixes. Backfill/reindex are global; `--bank` does not isolate them.

Current source defects remain: `get_memory` searches a capped list instead of an ID query; filtering after limit can omit eligible rows; reduced projection loses peer/session fields; subject attribution is discarded; bank statistics and call logs are insufficiently scoped. Tool descriptions do not prove validation or lifecycle filtering exists.

### Minimum next service slices, not a target tool count

```text
SLICE                   OPERATIONS                                  ISSUE
Core conversation       register/list peers; create/list sessions    #28/#31
                        membership; append/get ordered messages
Knowledge/evidence      create/revise/list conclusions as nodes     #26-#29
                        premises + reverse dependents
Context                 get_context; scoped peer representation     #31/#32
                        explicit sessions / bounded chain expansion
Chat                    answer with pinned citations                #32
                        save exchange/conclusion only explicitly
Progress                indexing/embedding freshness and failures   #30/#31
```

Session allowlists, taxonomy, and observer filters narrow recall; none grants permission. A named reusable scope can initially live in validated configuration; a new `scopes` table is not required. Default reads must not silently expand to all sessions just because a peer participates elsewhere.

## 15. Durability, authorization, and concurrency gates

This is a proposed initial deployment restriction, not a claim about all LanceDB capabilities: **one authorized application writer owns content mutations per dataset**. Python migrations run exclusively, not concurrently with application writes. A second host/process must not become an accidental second writer against R2.

```text
PROPOSED REVISION COMMIT SEQUENCE -- must be proven

1. Authenticate principal; authorize W and operation.
2. Resolve scoped operation_id retry/conflict before new base checks.
3. For a new operation, validate base/body/complete snapshots/targets.
4. Persist one canonical revision row including both snapshots.
5. Verify row completeness/digest; publish the current-revision head.
6. Acknowledge only after read-back confirms published state.
7. Derive term/link query projections and search; reconcile omissions.
   Projection writes are NOT on the publication critical path.

Crash before 5: prepared data must not become normal visible content.
Crash after 5: retry operation_id returns the accepted result.
Conflicting base: return conflict, do not silently overwrite.
Same operation_id with different payload: reject, do not reinterpret.
```

This is **not a cross-table transaction proof**. Publication visibility across table snapshots, crash recovery, idempotency, rejected-branch cleanup, and migration exclusivity all need tests. A prepared/orphan revision must not appear in normal history just because its row exists; the accepted head/ancestry and verified revision-row snapshots govern visibility; partial association projections must not redefine content. If tests cannot prove this protocol, change the physical layout/commit representation before shipping.

#23 defines versioned ID, omission/null, timestamp/Int64, JSON, error, source-message identity and scoped replay contracts, plus the target fixed-size Float32[384] physical shape. Accepted pure codecs do not establish durable cross-operation retry behavior (#26/#28), shared runtime transport enforcement (#31), or copy conversion (#34). Model/profile compatibility and revision-aware vector validation remain #30; dimensions alone do not establish compatibility. Per-table `UNIQUE(W,operation_id)` expresses a logical requirement, not an enforced LanceDB constraint or a universal cross-table retry namespace.

An append-only supersession event must pass expected-revision and current-lifecycle checks under the same serialization boundary. No writable duplicate replacement pointer is required initially; introduce a rebuildable projection only with explicit precedence and repair rules.

Fail closed at service boundaries: missing scope, unknown principal, inaccessible evidence, cross-workspace references, and unbounded chain expansion. A random ID is not permission. Redact secrets and sensitive source paths in logs, exports, prompts, and public rendering. Privacy deletion/redaction is a separate future policy; preserving ordinary correction history does not settle it.

## 16. Migration map: existing 15 -> candidate 19

```text
CURRENT                         PROPOSED
-------                         --------
workspaces/peers/sessions        keep core shapes; prove compatibility
session_peers/messages          keep conversation semantics

memories                        nodes + node_revisions
  name                          initial title (preserve legacy name)
  content                       body
  type                          term in vocabulary `type`
  peer_name                     preserve legacy attribution;
                                metadata.legacy_peer_name plus unresolved
                                marker; do NOT guess author vs observer
  subject_peer_name              subject_peer_name when known
  session_name                  optional revision context
  is_active/valid_from/valid_to  same meanings on initial revision
  embedding + sync columns      derived search migration/rebuild
  superseded_*                  reconcile with supersede_log

memory_terms                    initial revision term snapshot
                                -> derived node_revision_terms
vocabularies/terms              reuse; add explicit policy/scope
supersede_log                   keep history; add pinned revisions
traces/trace_hits               structured evidence + many results
  distilled_to/distilled_at     migrate legacy meaning to revision_links;
                                omit writable singular pair from target;
                                derive any compatibility display
mcp_calls/connections           keep; fix scope and attribution
read_cursors                    add workspace-safe identity

NEW                             session_links
NEW                             revision_links
NEW                             search_chunks_v1
```

Preserve unresolved legacy peer attribution specifically in `node_revisions.internal_metadata.legacy_peer_name` with `attribution_unresolved=true`; author/observer stay null unless separately evidenced.

Preserve legacy IDs through an explicit adapter/mapping. Convert unknown legacy type strings into reviewed compatible terms or flag them; never silently drop content. Reuse old vectors only when their profile/text provenance is known; otherwise rebuild. Do not infer an observer from the author, a session chain from timestamps, or a horizon from age.

Snapshot/export; migrate a copy; verify counts/digests/references/taxonomy/recall before switching. This document does not authorize destructive replacement.

## 17. Acceptance tests and build order

```text
PASS 1 -- contract and fixtures
  Python -> Arrow -> TS types/nullability/dimensions agree
  realistic Thai/English and multi-workspace fixtures
  no schema creation by accidental first-row inference

PASS 2 -- node/revision + taxonomy + evidence
  direct correction works without old_id
  missing/two type terms rejected; two horizons rejected
  stale base rejected; retries do not create duplicate revisions
  tag/evidence changes create revisions; old render remains stable
  renamed/retired terms do not corrupt old revisions

PASS 3 -- lifecycle and provenance
  corrects link does not implicitly supersede
  retire with new_id=NULL is excluded from normal recall
  cycles, competing replacements, cross-bank links rejected
  multiple traces/sessions per conclusion remain visible
  same source ID/different digest produces distinguishable evidence

PASS 4 -- failures and search
  embedder down: content save finishes without waiting for embedder
  crash at each commit step: no half-visible revision
  crash before chunks: reconciliation discovers missing work
  stale vectors never present superseded content as current truth
  query profile mismatch rejected; retries/counters remain truthful
  missing sources counted separately from unembedded chunks

PASS 5 -- access and interfaces
  HTTP/CLI/MCP enforce identical scope and validation
  call logs/statistics never leak another workspace
  latest-call ordering occurs before limit
  user-agent does not masquerade as registered peer identity
  CLI detects MCP isError and exits nonzero; flags are validated
  duplicate message replay is idempotent; changed-payload retry conflicts
  peer attribution survives message -> conclusion -> context round-trip
  context stays within budget and reports missing summary/partial indexes
  explicit scope + bounded chain expansion cannot admit foreign sessions
  equivalent structured targets match; different captures remain distinct
  passive URLs cannot trigger fetches; source text cannot authorize tools
  premise/dependent traversal respects access, depth and revision mode
  context/representation reads do not invoke models or mutate knowledge
  chat answer / saved exchange / saved conclusion stay separate
  external evidence permissions survive retrieval and rendering

PASS 6 -- migration and optional deployment
  migrate copy; verify preservation; rollback path rehearsed
  Honcho core export/import round-trip
  local first; R2 restart/read-after-write/concurrency tests if enabled
  authentication implemented before shared external exposure
```

Not automatic scope: full Honcho dreamer, a new message broker, arbitrary plugin execution from content types, duplicate transcript indexing, multi-writer deployment, or popularity-based forgetting.

### Implementation order reconciled with the existing roadmap

Reuse [roadmap #22](https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/22), not forty matching tickets.

```text
#23 contracts accepted + #24 scope repair closed
       |                |
       +----> #25 auth / fail-closed scope
       |
       +----> #26 revisions -> #27 taxonomy -> #29 lifecycle
       |               \-> #28 peers/messages/chains/evidence
       |
       +----> #30 save-first derived search / freshness
                         |
                    #31 shared API/MCP/CLI
                         |
                    #32 context FIRST, then optional chat
                         |
                    #33 Explorer/review UI
                         |
                    #34 copy migration + release proof
```

Arrows summarize order; issues hold full dependencies. Proposed refinements: capture #23/#28; evidence traversal #28/#31; context #31/#32. Issue bodies/code are not changed or marked complete here.

## 18. Final design in one sentence

**An explicit conversation-to-knowledge-to-context loop around simple revisionable nodes, one taxonomy, distinct peer roles and pinned evidence—stored in LanceDB, served by TypeScript, defined by Python, with rebuildable search and optional grounded chat.**

### Evidence used for this consolidation

- Relic reads of `89094970` and `2762e4e7`, their handoffs, and this conversation's later simplifications; not a claim to reread all 44 first-session subagents in this pass.
- Current spike source at [`71bc1d6`](https://github.com/Soul-Brews-Studio/arra-oracle-v4/tree/71bc1d6ce5694833baf285b6f4e457352f6b3e6c): `app/migrate-py/src/arra_migrate/models/`, `app/server/src/db.ts`, `app/server/src/index.ts`, and `app/server/src/mcp/{index,calls}.ts`.
- Baseline still attempts embedding before insertion; its nullable fallback is not the proposed save-first guarantee. New node/revision/type/peer-chat interfaces remain unbuilt.
- Prior discussions linked above are historical design evidence. This document distinguishes them from current source and from proposed behavior; it does not report a fresh runtime test suite pass.

- New evidence: Relic reads `01a0ba49…`/`01a0bcc0…`, sessions/pending discovery saved locally. Historical regression probes were not rerun.
- Fresh read-only native v4 `status`: server 26.9.18, local storage, all-minilm/384 configuration, 8 tools, authentication explicitly absent. Status configuration is not a successful embedding probe.
- Honcho: connected 40-tool contracts + read-only evidence in #35, not older local 3.0.12 alone. [MCP instructions](https://github.com/plastic-labs/honcho/blob/main/mcp/instructions.md) are reference, not requirements.

Written by Codex (AI), speaking as itself. Prior discussions remain historical records; this revision does not assert a completed migration, full test pass, or production readiness.
