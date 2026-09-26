# Overnight rulings, 2026-09-26/27

**Version**: `v26.9.26-alpha.2200`
**Made by**: v4-overnight (Claude Opus 5.5, AI), under Nat's standing instruction for tonight:
*"do anything you want … go until finish without any ask or wait me"*.

Almost every open issue ends with "needs a human ruling". Nat asked not to be asked
tonight, so each ruling below is made here. Each one gives the reason, the evidence it rests on, and how to
reverse it. None of them reopens a decision listed as closed in
`.tmp/understand` (Nat-intent map §2) or in AGENTS.md. Where a frozen contract
changes, the change is an **amendment section** appended to that contract with
this file cited, not a silent edit.

Overturn any line by saying so. Every ruling is isolated to its own slice
branch, so it reverts cleanly.

---

## R1 · #105 is misdiagnosed. The store is right; the dev seed is wrong

- **Ruling**: none of options a/b/c. `timestamp[us]` holds true microseconds; the
  kernel reads the raw `BigInt64Array` (`storage.ts:252-294`) and accepts every
  millisecond-aligned value. The failure comes from
  `app/just/scripts/create_target19_dataset.py:62`, which seeds
  `workspaces.created_at` with a microsecond-precision `datetime.now()`. The frozen
  contracts require that to fail closed (`context-ingestion-v1.md:57`,
  `read-cursor-v1.md:30`, `revision-publication-v1.md:44`).
- **Fix**: truncate to milliseconds in the producer. Correct the false comment at
  `mcp/connections.ts:136-153`. Stop the micros validators from accepting a JS
  `number` if no production caller passes one; a number can only come from the
  lossy accessor (LANCEDB-FACTS.md §1). The dev stack detects an existing
  sub-millisecond workspace row, says so, and tells the operator to regenerate it.
  It never deletes data itself.
- **Evidence**: understand agent issue-105; the acceptor's independent repro
  (`.tmp/acceptor/cursor-output.txt`); nexus measurements (LANCEDB-FACTS.md).
- **Reverse by**: reopening #105 with a failing service-level path.

## R2 · #75 read cursor: millisecond validation stays, the producer is fixed

- **Ruling**: `validateWorkspaceRow` keeps rejecting sub-millisecond workspace rows,
  and the fix goes into the producer (R1). The committed `read-cursor-v1.md` digest
  `04f553dd` is authoritative. The digest `164d3e91` pinned in the issue exists
  nowhere in git, and an amendment note records that.
- **Done means**: `advanceReadCursor` and then `getReadCursor` work live on a dataset seeded
  by the fixed script, at nonzero millisecond values.

## R3 · #87 membership is a real read boundary

- **Ruling**: option A, enforce. The Codex design lead already ruled this
  on 2026-09-21 ("membership becomes a real read boundary on
  listMessages/getMessage", 01a0ba49 #24717). That is a closed decision; this ruling
  applies it.
- **Shape**:
  - `listMessages` and `getMessage` take an optional `requester_peer_name`.
  - When it is present, current membership of that session is required, the same
    check `getContext` does.
  - When it is absent, the caller must hold `audit:read` on the workspace (operator
    view; the UI's dev operator has it). A `content:read`-only principal that
    names no requester gets 403.
- **Anti-spoofing, additive**: an `arra-auth/v1` workspace grant may list `peers: [...]`.
  When the list is present, any caller-asserted peer (requester, author, observer)
  must be in it. When it is absent, the trust unit remains the workspace, as
  today. This is explicit binding, so it does not contradict the closed rule
  "principal is not automatically any peer".
- **Reverse by**: dropping the enforcement lines. The binding field is optional
  and inert when unused.

## R4 · #85 `coverage` means complete, not "complete within what you may see"

- **Ruling**:
  - `coverage` is `"full"` only when nothing was excluded for any reason.
  - An unauthorized exclusion or any truncation makes it `"partial"`.
  - `excluded` stops returning `public_id`/`session_name` for unauthorized items,
    because that is the leak. It returns `{reason:"unauthorized", count}`.
    Budget and limit exclusions keep their identifiers.
- **Why**: the field exists so a caller can tell whether the answer is complete.
  "Full within your entitlement" gives a false answer to exactly the question it
  claims to answer. `chat-service.test.ts` asserts the old behaviour, so the
  test changes together with a `chat-v1.md` amendment. The UI badge follows in the
  same slice.

## R5 · #103 / #102 operations tables live in the operations root

- **Ruling**: option B. `mcp_calls` and `connections` are operational audit
  written on every request, and they live in `ARRA_DATA_DIR`. The knowledge
  readers (`listMcpCalls`, `listConnections`) move to that root.
- **Why**: the knowledge root sits behind an exclusive writer gate
  (`storage.ts assertInheritedGate`). Hot-path audit writes into it would couple
  every MCP request to the publication writer. The #102 writer already landed on
  `ARRA_DATA_DIR`. B is reversible.
- The target-19 copies of these two tables stay in the schema, empty until #34 migrates. That
  is documented beside `TARGET_SCHEMA`.
- #102 details:
  - `principal` = `credential_id`, which is the token id SPEC names.
  - `remote_ip` stays null. Capturing it is a privacy decision, not tonight's.

## R6 · #27 a sealed vocabulary is sealed on every transport

- **Ruling**:
  - `createTerm`, `renameTerm`, `retireTerm` and `reparentTerm` on a sealed
    vocabulary are refused through every transport.
  - Extending a sealed vocabulary is operator-only trusted configuration, with
    no transport path. That matches the existing rule that MCP never offers
    vocabulary delete (`mcp/tools.ts:8-11`).
  - No new policy action is added, since the closed action set is unchanged.
  - `taxonomy-write-v1.md` gets an amendment section recording the refusal
    precedence the tests pin.

## R7 · #28, #29, #30: code no client can call is not done

- **Ruling**: an issue does not close while its kernel has no transport route. All
  13 unreachable methods are exposed on HTTP and MCP. One slice owns
  `knowledge/registry.ts`, to avoid a merge war.
- **#28**:
  - Caller-asserted attribution (`created_by_peer_name`, `traces.peer_name`) is
    checked against the R3 peer binding when one is configured.
  - Mixed `continues`/`forked_from` cycles are refused across both link kinds
    (amendment to `session-link-v1.md` Decision 4).
  - The Relic adapter is a `relic` CLI subprocess returning JSON, behind an
    interface with a fake in tests. Tests never touch the real relic index.
  - Dereferencing external references stays deferred: references are passive
    (AGENTS rule 7).
- **#29**:
  - `listNodes` excludes retired and superseded nodes by default.
    `include_inactive: true` is history mode, and `total` counts the filtered set.
    The UI follows in the same slice.
  - The validity-window `as_of` is supplied by the transport at request time,
    so the kernel still takes no clock.
  - Superseding into a node that is already retired or superseded is refused.
- **#30**:
  - The chunk FTS index uses `ngram(3,3)`, no stemming and no stop-word removal,
    as SPEC §4.1.2 (latest, PR #106) says. It is the only measured tokenizer that
    finds the inside-word counterexample, ลืม inside หลงลืม. `icu` segments whole
    words and misses it.
  - One shared `FTS_INDEX_OPTIONS` module serves both stores, so they cannot
    diverge. The legacy `memories` path moves to the same `ngram(3,3)` (R14);
    it is the only live search today, and #10 requires the inside-word case
    on it. *(Amended 21:40: the first version of this ruling left legacy on
    `icu`, which cannot pass #10.)*
  - Keyword and semantic retrieval are separate methods, not fused. Fusing measured worse than
    either alone in relic's evaluation.
  - One table holds several embedding profiles, as built. DESIGN gets an amendment.

## R8 · #31 all 44 methods reachable on HTTP, MCP and CLI

- **Ruling**: keep the full contract; do not narrow it.
  - The CLI gets a generic `kb <method>` command generated from the same registry,
    so a method cannot be added to one transport and forgotten on the others.
    Friendly aliases cover the daily loop.
  - Existing byte caps stay. The CLI inherits the HTTP cap.
  - Unknown and unpermitted tools remain indistinguishable (current behaviour).
  - `indexRevisionChunks`, `reconcileSearchChunks` and `writeChunkEmbedding` are
    exposed under `content:write`, so an external embed worker can run the backfill
    Nat asked for ("index first embeded later like backfill").
  - Legacy memory commands stay, marked legacy in help.

## R9 · #32 chat model: local Ollama, pluggable, stub in tests

- **Ruling**: provider interface with an Ollama implementation. Nat: "use local
  ollama … we just go small".
  - Model `ARRA_CHAT_MODEL` defaults to `gemma3:4b`, installed on m5 and able to
    handle Thai.
  - Max output 512 tokens; timeout 60 s. No cost ceiling is needed while local.
  - With no model configured, `answerChat` fails with a closed, documented
    `model_unavailable` code (contract amendment), never a hang or a 500.
  - It is admitted under `content:read`, because it reads and does not write.
  - Unauthorized evidence never reaches the model, and a test proves it.
- The Anthropic and OpenAI providers are left as interface slots, unimplemented, until
  Nat picks one and a credential path.

## R10 · #89 a conclusion is a type term, not a table

- **Ruling**: accept `conclusion` as a reserved `type` term
  (`taxonomy.constants.ts:44`). There is no schema change, and #89 closes with this recorded.

## R11 · #34 migration: unknown legacy types become `note`, originals kept as tags

- **Ruling**: legacy free-text `memories.type` values that exactly match a reserved type
  term keep it. Everything else becomes `note`, and the original string is kept as
  a tag term, so nothing is lost. The rehearsal always runs on a copy.

## R14 · #10 Thai inside-word search, shared by both stores

- **Ruling**: option (a) from the #10 analysis.
  - `FTS_INDEX_OPTIONS = {baseTokenizer:"ngram", ngramMinLength:3, ngramMaxLength:3,
    prefixOnly:false, stem:false, removeStopWords:false}` lives in one module.
    `ensureFtsIndex` rebuilds under the same index name only when the live
    `indexDetails` differ, so an existing index is still kept when it matches.
  - Queries shorter than 3 code points fall back to a bounded, escaped `LIKE`
    scan, and the response says so with `match: "substring_scan"` (the default is
    `match: "ngram"`), as SPEC §4.1.2 says: "fall back to LIKE and say so".
  - Substring post-verification is on: overfetch the FTS candidates, keep rows
    that actually contain the query (case-folded), trim to the limit. This
    removes the measured ngram false positives (หลงทาง, ความทรงจำ).
- **Reverse by**: changing the one options constant back to `icu`; the tests
  name the behaviour each setting buys.

## R15 · #8 Honcho round-trip, phase 1 only

- **Ruling**:
  - The target is the v3.2.0 pin already in the repo.
  - Interchange is at REST level: lossy fields are listed in `LOSSY_FIELDS`, each
    with a reason.
  - Names outside `^[a-zA-Z0-9_-]+$` get a reversible encoding, proven by a
    round-trip test.
  - `messages.ingested_at NOT NULL` is recorded as an explicit exception to §15.1.
- The live run against a container stays blocked. Starting colima is a host
  change, and the shared white.local instance must never be used. Everything up to
  the live call is built and tested against a fixture.

## R16 · #7 recall measurement: harness now, judgments from Nat

- **Ruling**: build phase A:
  - a manifest-echoing harness;
  - origin labels that refuse to pair agent-authored qrels with a report
    labelled "independently judged";
  - a Bun LanceDB executor with the product profiles (`ngram3` from R14, plus
    `literal_includes` and vector).
- Phase B is Nat's: a private Thai/English corpus drawn from real memory
  content, and relevance judgments by someone other than the agent that wrote
  the queries. No quality number is published tonight. A number over an
  agent-authored corpus is exactly what the issue forbids.

## R17 · #34 migration backfill policies

- `vocabularies` created from legacy tags: `cardinality: many`,
  `required: false`, flat hierarchy.
- A null `supersede_log.reason` becomes `"legacy: reason not recorded"`, and the
  report counts these rows.
- `distilled_at` goes to `node_revisions.internal_metadata` of the distilled
  revision, never invented as `captured_at`. *(Corrected 22:00: the first version
  said "the trace link's `internal_metadata`", but `revision_links` has no such column
  (`TARGET_SCHEMA`); the v3-parity review found it.)*
- Migrated traces must be readable by the TS kernel. Map legacy `status:"raw"`
  to `open`, legacy ids to deterministic nanoid21 (R18 D1), and hit kinds
  outside `TARGET_KINDS` (e.g. `file`) per the trace contract, or reject them with
  a report entry.
- Scope is local datasets only. `writer_gate` refuses remote roots, and R2 is
  out of scope.
- The inherited gates are **release-excluded tonight and named in the report**:
  #7 (judgments), #8 (container), and #10's quality half. The rehearsal
  report must say so. It must never look green on their account.

## R18 · v3-compatible MCP adapter (#31 legacy adapters), rulings D1–D11 of V3-PARITY.md

The design is `docs/overnight/V3-PARITY.md`. Nat's bar (09-22 01:43) was "can v4 replace
v3". Measured usage on this machine: 709 real v3 tool calls; `oracle_search` 46%,
`oracle_learn` 26%.

- **D1** Legacy node id is `base64url(sha256("arra-legacy-node/v1\n"+ws+"\n"+id))[..21]`,
  shared byte for byte with #34. If both a direct and a derived node exist, the call
  is refused, never guessed.
- **D2** Adapter vocabularies are `concepts`, `legacy_type` and `project`. #34 creates the same ones.
- **D3** Recall paths (search, ask, recap, reflect) exclude superseded and retired
  nodes; browse paths (list, read) include them, flagged. This visible change from v3
  is stated in the tool descriptions.
- **D4** `oracle_research_note` publishes type `learning` (parity).
  `oracle_trace_distill` with `promoteToLearning:false` publishes `conclusion` (R10).
- **D5** `oracle_profile` is dropped: 0 calls, and it holds hardcoded persona data, not knowledge.
- **D6** Inbound `arra_*` aliases resolve; they are never listed.
- **D7** `closeSession` is accepted as a one-way close, recorded in
  `sessions.internal_metadata`. There is no new column.
- **D8** `X-Arra-Peer` is the connection-level speaker assertion, bound by R3 `peers:[…]`.
- **D9** v3 corpus import stays out of scope tonight (AGENTS rule 3). v3 ids do not
  resolve in v4 until an explicit import on a copy is requested.
- **D10** `ARRA_MCP_V3_COMPAT` stays off until the VA acceptance harness is green, then on.
- **D11** Linking two existing traces stays not carried. Traces are immutable (SPEC §14.4).
- **Never carried**: `oracle_mcp_call` and `oracle_mcp_list_tools`, because they run a
  caller-chosen command on the server.

## R19 · `connections.method` is the auth method, `bearer` today

- **Ruling**: SPEC §7.2 defines `connections.method` as the authentication method
  (`bearer | oauth | owner-session`), not the transport. Every request that reaches
  the fold was admitted by an arra-auth/v1 bearer credential, so the value is `"bearer"`.
  It used to be `"unknown"` for every row, because nothing passed a transport.
- The acceptor's #102 check required `"mcp"`, which is a transport. That check
  follows this ruling, or refutes it.
- **Reverse by**: making `method` carry the transport and amending SPEC §7.2.

## R20 · The embedding model digest is part of the profile identity, and it is never silently mixed or flipped

- **Ruling**:
  - The digest is pinned per dataset the first time a vector is actually written,
    from a real `/api/show` measurement taken in the same embed run.
  - Every `embedPendingChunks` run probes the live digest before embedding anything:
    - **unmeasurable** → embed nothing, return `blocked: "digest_unmeasured"`;
    - **measured and different** → embed nothing, fail closed with
      `embedding_profile_mismatch` naming both digests;
    - **equal**, or the first pin → proceed.
  - Server boot never pins and never flips anything. `getSearchFreshness` reports
    the pinned digest and the last measured one.
- **Why**: the verifier showed two failure modes. A model upgraded under the same
  name would silently mix vectors from two models. A boot that happened before
  Ollama came up would flip the profile id. Either way, a similarity search
  compares incomparable vectors. Failing closed makes an operator decide to
  re-index, which is a deliberate act.
- **Reverse by**: accepting mixed vectors, which is not recommended.

## R21 · Keyword search returns a rank, not the raw BM25 score; a missing embedder is `model_unavailable`

- **Ruling**:
  - `searchKnowledgeKeyword` returns an integer `rank` (1..n, a stable order) and no
    raw score. The FTS index is shared by every workspace, so a raw BM25 score
    carries corpus statistics from other workspaces. The search-query verifier
    measured 5.65 → 2.38 for the identical hit set after another workspace's data
    changed. That is a cross-tenant side channel.
  - Semantic search with no embedder, or with a failing one, answers
    `model_unavailable`, the same as chat after R9.
- **Reverse by**: a per-workspace index, which would make the score local.

## R12 · Model split tonight (corrects PLAN v0)

- Nat's latest rule (09-21 08:12, c30e0ba2 #14638): Sonnet codes; Opus and Fable plan and check.
  Tonight: Sonnet implements the S/M slices. Opus implements the security and contract
  slices (R3, R4, R6) and does all adversarial verification. Codex is the
  independent acceptor, the second model family.

## R13 · CI, the promise from 09-21 15:04 that was never kept

- **Ruling**: add `.github/workflows/ci.yml`, triggered on push and PR, running:
  - `bun install`
  - typecheck
  - the sharded suite
  - pytest

  There is no hourly cron, to spare Actions minutes on a private repo. Nat can add one.

## Not decided tonight: needs Nat or the outside world

- **#8**: a round-trip against stock Honcho needs a container runtime (colima is
  stopped; starting it is a host change) or a Honcho cloud credential. The export
  and import bundle and its fixture tests can still be built.
- **#7**: recall quality needs relevance judgments that agents did not write
  (the issue forbids agent-authored corpora). The harness can be built. The
  judgments cannot honestly be produced tonight.
- **Chat providers other than local Ollama, and anything that costs money.**
