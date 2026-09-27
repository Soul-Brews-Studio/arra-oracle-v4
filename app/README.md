# arra-oracle-v4 — active local app

Read [the current guide](../AGENTS.md) and [full target design](../DESIGN.md). The
overnight rulings R1–R22 live in [`docs/overnight/DECISIONS.md`](../docs/overnight/DECISIONS.md),
and their evidence is in [`docs/overnight/PROOF.md`](../docs/overnight/PROOF.md) (added in `6aa4ee3`,
updated after every merge since). Counts below were measured on `e00b50b` on 2026-09-27, except
the test-file counts, which were re-measured on `ec5c2c5` (2026-09-27, proof sweep).

This is a local prototype with bearer-token auth from a local policy file. It is **not**
unauthenticated. The 19-table target is built and served, but the default migrator does not
create it. A target19 dataset comes from the dev stopgap creator, or from the operator-only
copy migration `arra-migrate-copy` (#34), which writes a new candidate from a copy of a
legacy source. Both are described below.

```text
Python LanceModel registries                 local LanceDB, two roots
  models/        (active15, 15 tables) ----->  ARRA_DATA_DIR
                                                  memories: 8 legacy MCP tools,
                                                  /api/memories, /api/search,
                                                  13 legacy CLI commands
                                                  mcp_calls, connections: the
                                                  operations root (R5), written
                                                  AND read here

  target_v1/     (target19, 19 tables) ----->  ARRA_KNOWLEDGE_DATASET_ROOT
    dev:  create_target19_dataset.py             nodes/revisions/taxonomy/context/
    ops:  arra-migrate-copy (#34),               evidence/trace/lifecycle/search:
          new candidate from a copy              58 registry methods on HTTP,
                                                  MCP (kb_*) and CLI (kb <method>)
                          |                              |
                          v                              v
                       TypeScript / Bun 1.3.14 / Elysia 1.4.30 :3939
                       HTTP + MCP + source-run CLI, bearer auth required
                       25 v3-compatible MCP tools only with ARRA_MCP_V3_COMPAT=1
```

## Ownership and paths

| Path | Responsibility |
|---|---|
| `migrate-py/src/arra_migrate/models/` | Active Python schema registry (active15) |
| `migrate-py/src/arra_migrate/target_v1/` | Target Python schema registry (target19, `arra-v4-target/1`, 19 tables / 228 fields) |
| `migrate-py/src/arra_migrate/copy_migration/` | `arra-migrate-copy` (#34, R11/R17): operator-only copy of a legacy15 source into a NEW target19 candidate. No cutover, and not reachable over HTTP, MCP or the CLI |
| `migrate-py/src/arra_migrate/__main__.py` | active15 table creation and drift checks (`python -m arra_migrate[, --check]`) |
| `just/scripts/create_target19_dataset.py` | Dev-only stopgap that creates a target19 dataset and seeds its first `workspaces` row, with `created_at` truncated to milliseconds (R1) |
| `just/scripts/write_dev_policy.py` | Dev-only auth policy + bearer token writer (`arra-auth/v1` shape) |
| `just/scripts/run_dev_server.py` | Execs the server as the sole target19 writer, holding the fd-42 gate; defaults `ARRA_CHAT_PROVIDER=ollama` (line 45) |
| `server/src/` | Elysia HTTP/MCP, storage and application behavior. `src/knowledge/registry.ts` is the 58-method target19 method table. `src/mcp/tools.ts` is the MCP catalogue: 8 memory + 58 `kb_*` = 66 tools. `src/mcp/legacy-v3/` holds the 25 v3-compatible tools, served only with `ARRA_MCP_V3_COMPAT=1`. `src/chat-model*.ts` is the chat provider (R9) |
| `cli.ts`, `cli/` | CLI: 13 legacy memory commands, `kb <method>` for every registry method, 6 daily-loop aliases (#31), and `search --mode keyword\|semantic` over the knowledge tier (#30) |
| `cli.test.ts`, `server/test/` | Regression tests (156 `*.test.ts` files under `server/test/` on `ec5c2c5`, plus `cli.test.ts`; `git ls-tree -r --name-only HEAD -- app/server/test \| rg -c '\.test\.ts$'`); isolated fixtures/stubs; run per-kernel with `bun run test:<kernel>` (see Verification below) |
| `ui/v2/` | React UI, built into `server/public/v2` and served at `/v2/`; its own 67 unit-test files (on `ec5c2c5`) run with `bun test` there |
| ~~`migrate-rs/`, root `migrate-rust/`~~ | Rust experiments, removed — never schema owners. Recoverable from git history |
| ~~root `index-ts/`, `query-ts/`~~ | Spikes over the removed Rust dataset, removed — no producer, no importer. Recoverable from git history |
| `docs/history/` | Original dated POC reports, preserved verbatim |

The Python registry defines Arrow types; opening it from TypeScript does not add SQL foreign keys, uniqueness, authorization or cross-table transactions. Those need explicit application contracts and tests.

## Local run with an isolated dataset

`bun run --cwd app/server start` refuses to boot without `ARRA_AUTH_POLICY`, an
absolute path to an owner-only (0600) `arra-auth/v1` policy file. It exits 1 with
`ARRA_AUTH_POLICY must be an absolute path to the policy file`
(`composition.ts:84-87`). The sequence below starts a working server. It was re-run on
2026-09-27 against a fresh `mktemp -d` on `e00b50b`, with only `PORT` changed to a random
free port: every step exited 0, `/health` answered 200, and `tools/list` returned 65 tools. It also builds the
target19 dataset the knowledge transport needs, since the plain `arra_migrate`
migrator only creates active15.

`app/just/dev-stack.sh` runs all of this for you, under `app/.tmp/`, if you
just want a running server; the manual form is here so each step is legible.

```bash
# Choose a NEW isolated local directory; do not reset an existing bank.
ROOT="$(mktemp -d)"; PY=app/migrate-py/.venv/bin/python

ARRA_DATA_DIR="$ROOT/legacy15" $PY -m arra_migrate
ARRA_DATA_DIR="$ROOT/legacy15" $PY -m arra_migrate --check

# Dev stopgap: creates the 19 tables and seeds one workspace row ('default')
# directly, created_at truncated to milliseconds (R1). The reviewed path from
# existing legacy data is arra-migrate-copy (#34), which writes to a NEW directory.
$PY app/just/scripts/create_target19_dataset.py "$ROOT/target19"

# Writes dev-policy.json (0600) + dev-token.txt (0600, 64 lowercase hex),
# reused on repeat runs so the token doesn't rotate every restart.
$PY app/just/scripts/write_dev_policy.py "$ROOT/auth" default me

# Foreground process, localhost only; takes the fd-42 writer gate then execs
# bun, so the process holding the lock is the process serving requests.
ARRA_AUTH_POLICY="$ROOT/auth/dev-policy.json" ARRA_DATA_DIR="$ROOT/legacy15" \
ARRA_KNOWLEDGE_DATASET_ROOT="$ROOT/target19" PORT=3939 \
  $PY app/just/scripts/run_dev_server.py "$ROOT/target19" app/server
```

Startup requires Bun exactly `1.3.14` and Elysia exactly `1.4.30`, or it refuses.

Optional switches, read at startup, never from a request:

```text
ARRA_CHAT_PROVIDER   unset: answerChat answers model_unavailable | ollama (the only
                     implemented provider) | anthropic, openai (named slots, unimplemented)
ARRA_CHAT_MODEL      default gemma3:4b      512 output tokens, 60 s (pinned, not env)
ARRA_CHAT_URL        default OLLAMA_URL, else http://127.0.0.1:11434
ARRA_MCP_V3_COMPAT   exactly "1" enables the 25 v3-compatible MCP tools; anything else is off
EMBEDDING_MODEL      default all-minilm -> embedding profile ollama/all-minilm/384/none
```

`run_dev_server.py` sets `ARRA_CHAT_PROVIDER=ollama` unless you set it yourself, so the
dev stack answers chat with the local Ollama. A bare `bun run start` leaves chat off.

Startup leaves exactly one full-text index on `memories.content`: character trigrams, `ngram(3,3)` with stemming and stop-word removal off (R14; one shared constant in `server/src/fts/fts.constants.ts`). An existing index whose live `indexDetails` already match is kept untouched. One that differs, such as the `icu` index earlier builds created, is rebuilt once under the same name at the next startup; any second FTS index on the column is dropped. Explicit reindex remains a global maintenance operation and always rebuilds.

Keyword search (`recall` text mode, `GET /api/search?mode=text`) is a substring contract: every row returned contains the query, case-insensitively, and the answer says how it was found. `match: "ngram"` is the trigram index, with each candidate re-checked so trigram over-matches (`หลงทาง` against a stored `หลงลืม`) are dropped. `match: "substring_scan"` is a bounded, escaped scan for queries under 3 characters, which a trigram index cannot look up. `icu` was replaced because it cannot find Thai inside a word: `ลืม` against a stored `หลงลืม` returned nothing (#10).
Explicit reindex (like backfill) needs a bearer token with global `maintenance:*` grants.

The same absolute `ARRA_DATA_DIR` must reach migration and server. Default relative
`../data` depends on cwd and is unsuitable for ambiguous scripted runs. Never use
`ARRA_RESET=1` on existing data casually. Optional S3/R2 configuration exists for
`ARRA_DATA_DIR` only — the target19 root refuses any `://` path — and is not proof of
production concurrency or auth.

Default embedder configuration is Ollama `all-minilm`, 384 dimensions, with `OLLAMA_URL`,
`EMBEDDING_MODEL`, and `EMBEDDING_DIMENSIONS` overrides. On the knowledge tier the embedding
profile id is `ollama/<EMBEDDING_MODEL>/384/none` (`publication/search-chunk.profiles.ts:75-84`),
and a request naming any other profile is refused. The model digest is part of the profile's
identity (R20):

- every `embedPendingChunks` run measures it from Ollama `GET /api/tags`;
- the first vector write pins it in `<knowledge root>/.embedding-profile-pins.json`;
- a later run that measures a different digest fails with `embedding_profile_mismatch`;
- a run that cannot measure one embeds nothing and answers `blocked: "digest_unmeasured"`;
- boot never probes and never pins.

Do not change a live table's dimension or profile through environment settings and assume
compatibility. Ollama is an HTTP service; locality depends on the configured URL. No cloud
call is needed for the regression suite, whose models are stubs.

## Current interfaces

Every route needs `Authorization: Bearer <64 lowercase hex>` except `/health` and the
static UI (`GET /`, `/knowledge.html`, `/v2/*`). Those are deliberately public and skip
policy admission, but not the Host/Origin gate, which runs on every request (`app.ts:152-155`,
`app.ts:468-497`; `authorization-integration-v1.md:34`). Measured 2026-09-27:

```text
GET /, /v2/index.html, /knowledge.html, /health   no token      200
GET /api/health?bank=default                      no token      401
GET /api/health                  (no ?bank)       no token      400
GET /                                             foreign Host  400
```

A missing, repeated or malformed `?bank` is refused with 400 before admission (`app.ts:93-99`,
`:268-273`), so the 401 needs a bank (`test/auth-integration.test.ts:97-107`,
`test/mcp-correctness.test.ts:436-439`).

The bearer's policy grants (`content:read`/`write`, `audit:read`, `diagnostics:read`,
`maintenance:backfill`/`reindex`) gate every protected method. The dev policy from
`write_dev_policy.py` grants the first four on its workspace, and no global maintenance. A
grant may also carry `peers: [...]` (R3). Every caller-asserted peer field
(`server/src/knowledge/registry.peerFields.ts`) must then be in that list, or the request
gets 403.

Message reads are behind membership (R3). `listMessages`, `getMessage` and
`listSessionMembers` take a `requester_peer_name`:

- `listMessages` and `listSessionMembers`: a requester that is not a current member (a
  stranger, a departed member, a peer that does not exist) gets `invalid_reference` at
  `/requester_peer_name` (HTTP 400, or MCP `isError`).
- `getMessage`: a non-member reads `null` (HTTP 200, MCP result text `null` with no
  `isError`), the same as an absent id, so the answer never reveals that the id exists
  (`publication/service.getMessage.ts:18-26`; `authorization-v1.md` §3;
  `context-ingestion-v1.md` R3 amendment).
- A caller who names no requester must hold `audit:read` on the workspace (the operator view);
  otherwise the answer is 403 `forbidden`.

MCP endpoint: `/mcp/:bank`, with bank = `workspaces.name` (not credentials). `tools/list`
returns up to **66 tools**, filtered to what the caller's token grants: 8 legacy memory tools
plus 58 `kb_<method>` tools generated from `src/knowledge/registry.ts`, one per knowledge
kernel method (34 `content:read`, 22 `content:write`, 2 `audit:read`). `kb_*` tools are
listed only when `ARRA_KNOWLEDGE_DATASET_ROOT` is configured. Measured live with the dev
policy: 65.

```text
remember recall get_memory list_memories
bank_info call_log call_stats status

kb_getAcceptedHead kb_listAcceptedHistory kb_listNodes kb_publishRevision
kb_getVocabulary kb_getTerm kb_lookupVocabularyByName kb_lookupTermByName
kb_listTerms kb_listTermUsage kb_knowledgeStats kb_createVocabulary kb_createTerm
kb_renameTerm kb_retireTerm kb_reparentTerm kb_seedReservedVocabularies kb_getPeer
kb_getSession kb_getMessage kb_listMessages kb_listPeers kb_listSessions
kb_getReadCursor kb_registerPeer kb_registerSession kb_joinSession kb_appendMessages
kb_advanceReadCursor kb_getContext kb_listMcpCalls kb_listConnections kb_answerChat
kb_getChatSettings kb_listSessionLinks kb_createSessionLink kb_closeSession
kb_listSessionMembers kb_getTrace kb_listTraceHits kb_createTrace kb_listTraces
kb_getRecallEligibility kb_listLifecycleHistory kb_retireNode kb_supersedeNode
kb_listSearchChunks kb_getSearchFreshness kb_indexRevisionChunks
kb_writeChunkEmbedding kb_reconcileSearchChunks kb_embedPendingChunks
kb_searchKnowledgeKeyword kb_searchKnowledgeSemantic kb_getRevisionAssociations
kb_scanDependents kb_reconcileRevisionAssociations
```

**v3-compatible tools** (R18; design in `docs/overnight/V3-PARITY.md`). The family lives in
`server/src/mcp/legacy-v3/` and is served only with `ARRA_MCP_V3_COMPAT=1` (exactly `1`,
`composition.ts:211-213`). It lets an existing arra-oracle v3 client talk to v4 unchanged.
Measured live with the flag on, before D3b added `getRepresentation`: `tools/list` returns 90 (8 + 57 + 25).

```text
carried (25)   ____IMPORTANT
               oracle_learn oracle_research_note oracle_handoff oracle_supersede
               oracle_search oracle_ask oracle_read oracle_list oracle_stats
               oracle_concepts oracle_reflect oracle_recap oracle_inbox oracle_verify
               oracle_thread oracle_threads oracle_thread_read oracle_thread_update
               oracle_trace oracle_trace_get oracle_trace_list oracle_trace_chain
               oracle_trace_distill oracle_search_chain
not carried    oracle_mcp_call oracle_mcp_list_tools   run a caller-chosen command
               oracle_trace_link oracle_trace_unlink   traces are immutable (D11)
               oracle_profile                          0 calls, hardcoded persona (D5)
```

A not-carried name answers 403, byte-identical to an unknown tool. An inbound `arra_*`
alias resolves to its `oracle_*` tool and is never listed (D6). `X-Arra-Peer` names the
speaker and is read only while the flag is on; it is bound by the grant's `peers` (D8).

Recall tools (search, ask, reflect, recap, inbox) exclude superseded, retired, inactive and
out-of-window nodes. Browse tools (list, read) include them, flagged (D3). No v3 corpus is
imported (D9).

Knowledge search (#30; `app/docs/contracts/search-chunk-v1.md`) answers with NODES of the
target19 tier, one hit per node, at the node's current head revision. Only recall-eligible
nodes appear: not retired, not superseded, `is_active`, and inside `[valid_from, valid_to)` at
request time (#29).

- `kb_searchKnowledgeKeyword` uses the same shared `ngram(3,3)` substring contract as the
  legacy path.
  - Every hit is re-checked against the node's whole head text, so an occurrence cut by a
    chunk boundary is still found.
  - The answer carries `match: "ngram"` or `"substring_scan"`, plus `scan_reason`:
    `short_query` below 3 code points, or `index_unavailable`.
  - The index on `search_chunks_v1.text` is built and refreshed by the writer in
    `indexRevisionChunks`. A fresh dataset answers `index_unavailable` until the first run,
    as measured.
  - Hits carry an integer `rank`, never the raw BM25 score (R21).
  - Hit ORDER comes only from this workspace's own rows (R22): occurrences of the query in the
    head text, then the most recently accepted head, then node id. The shared index's BM25 only
    picks candidates (every one is read, up to 4096 candidate chunks), so another workspace's
    writes cannot reorder this workspace's hits below that bound (`search-chunk-v1.md` §20).
  - Both keyword and semantic answers also carry `coverage: "full" | "partial"`,
    `coverage_reason` (`"candidate_ceiling"` or `null`) and `candidate_ceiling` (4096): whether
    the underlying candidate read hit its own bound, so more matches may exist unread
    (`search-chunk-v1.md` §21). The v3 adapter's `oracle_search`/`oracle_ask` fold a `"partial"`
    answer into `compat_warnings` (§22), and so does `oracle_search_chain`, OR-ed across its hops
    (§24, PR #127; `mcp/legacy-v3/tools/oracle_search_chain.ts:81`).
- `kb_searchKnowledgeSemantic` embeds the query with the composed local Ollama model and ranks
  READY chunk vectors of the active profile (`ollama/all-minilm/384/none` by default) by
  `metric: "l2_squared"` `distance`. No embedder, or a failing one, answers `model_unavailable`
  (R21).

The two searches are never fused (R7).

Index first, embed later: `indexRevisionChunks` saves chunks with no vector, and
`embedPendingChunks` fills the vectors later, like a backfill. `getSearchFreshness` reports
pending and ready counts plus `model_digest {pinned, last_measured}`.

CLI: `search --bank B --query Q --mode keyword|semantic [--profile P]`. A bare `search` stays
the legacy memories search (`--mode text|vector`, default `text`).

Chat (`kb_answerChat`, `content:read`, R9) grounds an answer in `getContext` evidence, using the
local Ollama model. `coverage` is `"full"` only when nothing was excluded, and an unauthorized
exclusion is reported as `{reason:"unauthorized", count}` (R4). `kb_getChatSettings` shows the
provider, model and limits, never the URL. Measured on the dev stack:
`{"provider":"ollama","model":"gemma3:4b","max_output_tokens":512,"timeout_ms":60000}`.

HTTP surface:

```text
GET  /health                              GET  /api/health?bank=
GET  /api/memories?bank=                  POST /api/memories
GET  /api/search?bank=                    POST /api/backfill
POST /api/reindex                         POST /api/knowledge/:bank/:method
POST /mcp/:bank                           POST /mcp/:bank/:workspace  (always 400)
GET  /  /knowledge.html  /v2/*            static assets
```

`POST /api/knowledge/:bank/:method` is the HTTP leg of the 58 `kb_*` methods above — one
RPC-style route per method, body `workspace_name` must equal `:bank`, capped at 1 MiB
(the MCP leg caps at 256 KiB). Backfill and reindex are global maintenance operations in
this prototype; a `?bank` on either gives 400. Do not infer bank isolation from an
unrelated CLI `--bank`. The obsolete extra `/mcp/:bank/:workspace` segment must not be
interpreted as a second tenant/context boundary; the repaired handler rejects it
explicitly.

`/api/knowledge/:bank/:method` dispatches to whichever methods `app/server/src/knowledge/registry.ts` names. The same methods are `kb_<method>` MCP tools with a `{payload:{...}}` wrapper.

```bash
export ARRA_URL=http://127.0.0.1:3939
export ARRA_TOKEN="$(cat "$ROOT/auth/dev-token.txt")"

bun app/cli.ts help
bun app/cli.ts status --bank default --pretty
bun app/cli.ts remember --bank default --content 'A reviewed fact' --peer neo --subject nat
bun app/cli.ts recall --bank default --query 'reviewed' --mode text
```

Every command except `health` needs `ARRA_TOKEN`. It is the **only** credential source:
there is no `--url`-carried credential and no config-file lookup, and `--url` is rejected
outright if it carries a username/password. Measured: with no token, `ARRA_TOKEN must be
exactly 64 lowercase hex characters`, exit 1.

The CLI covers 13 legacy backend commands plus help (kept for compatibility, not removed). It validates arguments, forwards subject attribution, and exits nonzero for HTTP/JSON-RPC/MCP tool errors. It preserves JSON envelopes. It is not an installed global binary.

### `kb <method>` — every knowledge registry method, generated (#31 R8)

```bash
bun app/cli.ts kb --help                                   # list every method (derived from registry.ts; never hand-copied)
bun app/cli.ts kb <method> --help                           # that method's action and workspace_name scope
bun app/cli.ts kb <method> --bank example --json '<json>'   # forward the JSON literal, byte-exact, over HTTP
bun app/cli.ts kb <method> --bank example --file req.json   # same, reading the body from a file
bun app/cli.ts kb <method> --bank example --stdin           # same, reading the body from stdin
```

`kb <method>` posts to `POST /api/knowledge/<bank>/<method>` for **any** name in `KNOWLEDGE_METHOD_NAMES`
(`app/server/src/knowledge/registry.ts`) — a method added to the registry needs no CLI change to become
reachable here. The request body is forwarded exactly as given (never re-`JSON.stringify`d, so duplicate
keys reach the server's own strict parser unchanged); it must carry `workspace_name` at the scope the
registry names, equal to `--bank`. A non-2xx response prints the server's governed error envelope
unchanged and the command exits nonzero. Credential handling (`ARRA_TOKEN` only, one `Bearer` header,
loopback/HTTPS rule, redirect refusal, never printing the token) is the exact same code path the 13
legacy commands use.

Six friendly aliases (`app/cli/kb.aliases.ts`) wrap a `kb` call with plain flags for the daily
loop (`--bank` still required), and `search --mode keyword|semantic` reaches the two knowledge
searches:

```bash
bun app/cli.ts peer add --bank example --name nat                                   # registerPeer
bun app/cli.ts session add --bank example --name standup                            # registerSession
bun app/cli.ts kb joinSession --bank example \
  --json '{"workspace_name":"example","session_name":"standup","peer_name":"nat"}'  # no alias
bun app/cli.ts message append --bank example --session standup --peer nat --content 'hello'  # appendMessages
bun app/cli.ts nodes list --bank example --limit 20                                 # listNodes
bun app/cli.ts nodes list --bank example --limit 20 --history   # include_inactive: retired/superseded, labelled
bun app/cli.ts context get --bank example --peer nat --session standup              # getContext
bun app/cli.ts chat ask --bank example --peer nat --session standup --question 'what happened?'  # answerChat
bun app/cli.ts search --bank example --query 'ลืม' --mode keyword                   # searchKnowledgeKeyword
bun app/cli.ts search --bank example --query 'deploy' --mode semantic               # searchKnowledgeSemantic
```

Measured on a fresh dev stack on 2026-09-27, run in this order: every line except
`chat ask` exited 0, and `context get` returned the appended message (`chat ask` was not run,
to keep the local model out of it).

The `kb joinSession` step is required. Without it, `message append` answers
`"outcome":"stopped"` with `invalid_reference` and still exits 0, and then `context get` exits 1
with `invalid_reference` at `/peer_name`. Membership is a boundary (R3), and no alias covers
joining.

Two more behaviours:

- `chat ask` waits up to 75 s, longer than the server's 60 s model bound, so a slow answer
  arrives as the server's own result (`app/cli.ts:187-194`).
- `bun app/cli.ts help` does not list `--history` for `nodes list`, although the alias
  accepts it.

These are thin: they map a handful of flags onto the method's known closed-key request shape (minting a
`peer_id`/`session_id`/`public_id` when one is not given) and otherwise do no validation the server does
not already do more strictly. `node create`/`node revise` (`publishRevision`) are deliberately not aliased
— that request is a governed revision envelope, not a flat object — use `kb publishRevision --json/--file`
directly. Implementation lives under `app/cli/` (one function per file); `app/cli.ts` stays the entry point.

## Verification and remaining scope

`bun run --cwd app/server test` runs the **entire** suite in one process: 133 files under
`app/server/test/` plus `app/cli.test.ts`, 134 in all. The single-process run was measured
only at baseline `f919369` (68 files, 1123 tests, about 497 s, almost serial). Prefer one of:

```bash
bun run --cwd app/server test:fast          # <35s-per-file tier only
bun run --cwd app/server test:<kernel>      # e.g. test:context, test:taxonomy, test:auth, test:mcp
TEST_SHARDS=6 bun run --cwd app/server test:parallel   # full suite, sharded (default 6; CI uses 4)
bun run --cwd app/server typecheck
bun run --cwd app/server build
bun test app/cli.test.ts
(cd app/server && bun test test/mcp-v3-acceptance.test.ts)   # v3 client acceptance harness
(cd app/ui/v2 && bun test)                                  # UI unit tests, not in CI

# Python (app/migrate-py) — there is no pytest config or dependency; this is the real command:
uv sync --project app/migrate-py --frozen
PYTHONPATH=app/migrate-py/src app/migrate-py/.venv/bin/python \
  -m unittest discover -s app/migrate-py/tests -v

# `discover` does NOT reach tests/fixtures/*-v1/ (neither directory has an
# __init__.py; both files document this and give this exact command). Run
# them explicitly, with the ResourceWarning-as-error the fixture-lane contract
# requires (app/docs/contracts/taxonomy-write-v1.md:98). Measured 2026-09-27 on
# e00b50b: 268 OK, 1 skipped (discover) + 17 OK (publication) + 22 OK (taxonomy).
# Discovery includes the kernel-import guard in tests/test_revision_v1.py, which
# fails when a new TS file imports the publication kernel without review.
cd app/migrate-py
PYTHONPATH=src:tests .venv/bin/python -W error::ResourceWarning \
  tests/fixtures/publication-v1/test_export_publication_fixture.py -v
PYTHONPATH=src:tests .venv/bin/python -W error::ResourceWarning \
  tests/fixtures/taxonomy-v1/test_export_taxonomy_fixture.py -v
```

`app/benchmarks` has its own 123 Python tests (`test_harness_*.py`, `test_retrieval_metrics.py`)
outside both discovery roots above. Measured 2026-09-27: 123 OK. Run them with the same venv:
`cd app/benchmarks && ../migrate-py/.venv/bin/python -m unittest discover -s . -p 'test_*.py'`.

Results measured on this base:

```text
typecheck                               clean                                   2026-09-27, e00b50b
v3 client acceptance harness            PASS 37 / FAIL 0 / GAP 0 (39 tests)     2026-09-27, e00b50b
UI v2 unit tests                        106 pass / 0 fail, 9 files              2026-09-27, e00b50b
full sharded suite (6 shards)           1972 pass / 0 fail, 134/134 files, 183 s
                                        gate 9 on 87f9f06; to e00b50b only docs/overnight/PLAN.md changed
```

The v3 client acceptance harness (`app/server/test/mcp-v3-acceptance.test.ts`) replays a
recorded real v3 client session over `POST /mcp/:bank` on a fresh gated dataset. Its argument
keys come from real recorded calls, and its output shapes cite v3 source.

CI is green on the integration branch: run 36275352354 (`0a98289`) passed with 1985 tests / 0 failures
across 139 files on Linux. The earlier failures were Linux E2BIG (argv strings over 128 KiB)
and runner timing, both fixed by the ci-green slice (R13).

**The live acceptance probe is not part of this repo.** It is the independent acceptor's
instrument, a gitignored scratch directory in the overnight integration worktree:

```bash
bash <overnight worktree>/.tmp/acceptor/live-probe/run.sh <checkout> <label> [--issues]
```

It starts the real gated server on a fresh `mktemp -d` with stub models and three principals
over two workspaces. It calls every knowledge method on HTTP, MCP and CLI, plus the isolation
probes, and writes a matrix. The optional `--issues` flag adds the per-issue acceptance
checks. Exit 2 means a harness gap such as a missing payload fixture, not a product failure.

Measured on `e00b50b`:

- `run.sh … final-docs`: 57 methods, 57 on HTTP, 57 on MCP, 57 on CLI; isolation 191 PASS /
  0 FAIL; 26 payload gaps, which are the stateful methods only `--issues` seeds.
- `--issues`: the same matrix with 6 gaps, and issue checks 137 PASS / 0 FAIL / 7 GAP.

Writing tests that also pass on the 2-core GitHub runner (R13, `docs/overnight/DECISIONS.md`):

- An explicit test or hook timeout is `testTimeout(ms)` (`test/helpers/timing.testTimeout.ts`);
  a window a test waits out (a child deadline, an injected timeout, a "never a hang" bound) is
  `scaledMs(ms)`. Both return `ms` unchanged locally; CI sets `TEST_TIME_SCALE=5` (the runner
  measured about 4.6x slower per file) and `TEST_TIMEOUT_MS=60000`.
- Prove "X happened before Y" with a handshake (an observed signal or settle order), never
  with an elapsed-time bound.
- Linux refuses any single argv or env string over 131071 bytes with E2BIG; macOS does not.
  `runGated`/`spawnGatedChild` spill larger arguments to a file, and a child reads its payload
  with `readArgPayload` (`test/helpers/argv.readArgPayload.ts`). `runOwnedChild` refuses an
  oversized string on every platform.

`bun run typecheck` shells out to a bare `tsc` on PATH; `package.json` intentionally
carries no `typescript` devDependency (measured: `tsc --version` only resolves because a
global compiler happens to be installed). CI installs one explicitly as a toolchain step.
`skipLibCheck` excludes dependency declaration diagnostics, not our source/tests.

Inspect the actual test output; a help check is not a live backend test, and passing
current regressions is not proof that the future schema is implemented. Use temporary
data and stub model calls. Keep existing app data, v3, and other agents' services
untouched.

The roadmap is [#22](https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/22).
Auth (#25), schema codecs (#23), current-scope MCP fixes (#24) and immutable revision
commit/recovery (#26) are **closed**.

These are still **open on GitHub** (measured 2026-09-27):

- the roadmap issues: taxonomy (#27), peer/message/trace provenance (#28), lifecycle (#29),
  derived search (#30), the unified API/MCP/CLI contract (#31), context/chat (#32), the UI
  (#33), migration/release proof (#34);
- the defects #85, #87, #89, #102, #103, #105 and #75;
- the verification gates #7, #8 and #10.

On the overnight integration branch each one has a ruling in `docs/overnight/DECISIONS.md`
and code. AGENTS.md's work map shows the acceptor's per-issue checks on this base. None
closes until the integration PR is reviewed.

Real remaining limits:

- #7 needs relevance judgments that no agent wrote.
- #8's live round-trip against stock Honcho needs a container runtime.
- `arra-migrate-copy` stops at a candidate on a copy, with no cutover.

`DESIGN.md`'s body is the 2026-09-20 snapshot of #36. Its closing amendment section lists what
is built now against what is still target.
