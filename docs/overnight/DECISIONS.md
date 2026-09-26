# Overnight rulings, 2026-09-26/27

**Version**: `v26.9.26-alpha.2125`
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
  - The legacy `memories` path keeps `icu` and is left alone.
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
