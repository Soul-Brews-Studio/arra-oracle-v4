# arra-oracle-v4 — active local app

Read [the current guide](../AGENTS.md) and [full target design](../DESIGN.md). Tonight's
rulings on the open gaps below live in [`docs/overnight/DECISIONS.md`](../docs/overnight/DECISIONS.md).

This is a local prototype with bearer-token auth from a local policy file — **not**
unauthenticated, and not the completed 19-table design's default migration path (the
19-table target is built and served, but only through a dev-stopgap dataset creator; see
below).

```text
Python LanceModel registries                 local LanceDB, two roots
  models/        (active15, 15 tables) ----->  ARRA_DATA_DIR
                                                  memories, mcp_calls (write),
                                                  connections (write) — legacy
                                                  8 MCP tools, /api/memories,
                                                  /api/search, the CLI

  target_v1/     (target19, 19 tables) ----->  ARRA_KNOWLEDGE_DATASET_ROOT
    (dev stopgap creator only,                   nodes/revisions/taxonomy/
     no reviewed migration CLI)                  context/evidence/trace/... 44
                                                  kb_* methods, HTTP+MCP+CLI
                                                  (no migration between roots)
                          |                              |
                          v                              v
                       TypeScript / Bun 1.3.14 / Elysia 1.4.30 :3939
                       HTTP + MCP + source-run CLI, bearer auth required
```

## Ownership and paths

| Path | Responsibility |
|---|---|
| `migrate-py/src/arra_migrate/models/` | Active Python schema registry (active15) |
| `migrate-py/src/arra_migrate/target_v1/` | Target Python schema registry (target19); no reviewed migration CLI yet |
| `migrate-py/src/arra_migrate/__main__.py` | active15 table creation and drift checks (`python -m arra_migrate[, --check]`) |
| `just/scripts/create_target19_dataset.py` | Dev-only stopgap that creates a target19 dataset and seeds its first `workspaces` row |
| `just/scripts/write_dev_policy.py` | Dev-only auth policy + bearer token writer (`arra-auth/v1` shape) |
| `just/scripts/run_dev_server.py` | Execs the server as the sole target19 writer, holding the fd-42 gate |
| `server/src/` | Elysia HTTP/MCP, storage and application behavior. `src/knowledge/registry.ts` is the 46-method target19 method table; `src/mcp/tools.ts` is the MCP catalogue (8 memory + 46 `kb_*` = 54 tools) |
| `cli.ts`, `cli/` | CLI: 13 legacy memory commands plus `kb <method>` for every registry method, and daily-loop aliases (#31), including `search --mode keyword\|semantic` over the knowledge tier (#30) |
| `cli.test.ts`, `server/test/` | Regression tests; isolated fixtures/stubs; run per-kernel with `bun run test:<kernel>` (see Verification below) |
| ~~`migrate-rs/`, root `migrate-rust/`~~ | Rust experiments, removed — never schema owners. Recoverable from git history |
| ~~root `index-ts/`, `query-ts/`~~ | Spikes over the removed Rust dataset, removed — no producer, no importer. Recoverable from git history |
| `docs/history/` | Original dated POC reports, preserved verbatim |

The Python registry defines Arrow types; opening it from TypeScript does not add SQL foreign keys, uniqueness, authorization or cross-table transactions. Those need explicit application contracts and tests.

## Local run with an isolated dataset

`bun run --cwd app/server start` refuses to boot without `ARRA_AUTH_POLICY` (an
absolute path to an owner-only, 0600 `arra-auth/v1` policy file) — measured:
`ARRA_AUTH_POLICY must be an absolute path to the policy file`, exit 1. The
sequence below is the one that actually starts a working server, measured
against a fresh `mktemp -d` on this checkout. It also builds the target19
dataset the knowledge transport needs, since the plain `arra_migrate` migrator
only creates active15.

`app/just/dev-stack.sh` runs all of this for you, under `app/.tmp/`, if you
just want a running server; the manual form is here so each step is legible.

```bash
# Choose a NEW isolated local directory; do not reset an existing bank.
ROOT="$(mktemp -d)"; PY=app/migrate-py/.venv/bin/python

ARRA_DATA_DIR="$ROOT/legacy15" $PY -m arra_migrate
ARRA_DATA_DIR="$ROOT/legacy15" $PY -m arra_migrate --check

# Dev stopgap: no reviewed target19 CLI exists yet. Creates the 19 tables and
# seeds one workspace row ('default') directly.
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

Startup leaves exactly one full-text index on `memories.content`: character trigrams, `ngram(3,3)` with stemming and stop-word removal off (R14; one shared constant in `server/src/fts/fts.constants.ts`). An existing index whose live `indexDetails` already match is kept untouched. One that differs, such as the `icu` index earlier builds created, is rebuilt once under the same name at the next startup; any second FTS index on the column is dropped. Explicit reindex remains a global maintenance operation and always rebuilds.

Keyword search (`recall` text mode, `GET /api/search?mode=text`) is a substring contract: every row returned contains the query, case-insensitively, and the answer says how it was found. `match: "ngram"` is the trigram index, with each candidate re-checked so trigram over-matches (`หลงทาง` against a stored `หลงลืม`) are dropped. `match: "substring_scan"` is a bounded, escaped scan for queries under 3 characters, which a trigram index cannot look up. `icu` was replaced because it cannot find Thai inside a word: `ลืม` against a stored `หลงลืม` returned nothing (#10).
Explicit reindex (like backfill) needs a bearer token with global `maintenance:*` grants.

The same absolute `ARRA_DATA_DIR` must reach migration and server. Default relative
`../data` depends on cwd and is unsuitable for ambiguous scripted runs. Never use
`ARRA_RESET=1` on existing data casually. Optional S3/R2 configuration exists for
`ARRA_DATA_DIR` only — the target19 root refuses any `://` path — and is not proof of
production concurrency or auth.

Default embedder configuration is Ollama `all-minilm`, 384 dimensions, with `OLLAMA_URL`,
`EMBEDDING_MODEL`, and `EMBEDDING_DIMENSIONS` overrides. Do not change a live table's
dimension/profile through environment settings and assume compatibility. Ollama is an
HTTP service; locality depends on the configured URL. No cloud call is needed for the
regression suite.

## Current interfaces

Every route needs `Authorization: Bearer <64 lowercase hex>` except `/health` and the
static UI (`GET /`, `/knowledge.html`, `/v2/*`), which are deliberately public and skip
policy admission — not the Host/Origin gate, which still runs on every request
(`app.ts:414-444`; `authorization-integration-v1.md:34`). Measured: `GET /` and
`GET /v2/index.html` both return 200 with no token. The bearer's policy grants
(`content:read`/`write`, `audit:read`, `diagnostics:read`, `maintenance:backfill`/`reindex`)
gate every protected method; see `write_dev_policy.py` above for the dev shape.

MCP endpoint: `/mcp/:bank`, with bank = `workspaces.name` (not credentials). `tools/list`
returns up to **54 tools**, filtered to what the caller's token grants: 8 legacy memory tools
plus 46 `kb_<method>` tools generated from `src/knowledge/registry.ts`, one per knowledge
kernel method. The 13 session-link, trace, lifecycle and search-chunk methods were exposed on
2026-09-26 (overnight R7/R8); before that they had no route. The two knowledge search methods
(#30, R7/R14) were added the same night.

```text
remember recall get_memory list_memories
bank_info call_log call_stats status

kb_getAcceptedHead kb_listAcceptedHistory kb_listNodes kb_publishRevision
kb_getVocabulary kb_getTerm kb_createVocabulary kb_createTerm kb_renameTerm
kb_retireTerm kb_reparentTerm kb_seedReservedVocabularies kb_getPeer kb_getSession
kb_getMessage kb_listMessages kb_listPeers kb_listSessions kb_getReadCursor
kb_registerPeer kb_registerSession kb_joinSession kb_appendMessages
kb_advanceReadCursor kb_getContext kb_listMcpCalls kb_listConnections kb_answerChat
kb_listSessionLinks kb_createSessionLink kb_getTrace kb_listTraceHits kb_createTrace
kb_getRecallEligibility kb_listLifecycleHistory kb_retireNode kb_supersedeNode
kb_listSearchChunks kb_indexRevisionChunks kb_writeChunkEmbedding
kb_reconcileSearchChunks kb_searchKnowledgeKeyword kb_searchKnowledgeSemantic
kb_getRevisionAssociations kb_scanDependents kb_reconcileRevisionAssociations
```

Knowledge search (#30; `app/docs/contracts/search-chunk-v1.md`, amendment "overnight R7 (#30
part) + R14") answers NODES of the target-19 tier at their current head revision, never retired
or superseded ones, one hit per node: `kb_searchKnowledgeKeyword` uses the same shared
`ngram(3,3)` substring contract as the legacy path (`match: "ngram"` or `"substring_scan"`),
checked against the node's whole head text, so an occurrence cut by a chunk boundary is still
found; hits are ordered from the workspace's own rows (occurrences of the query, then the most
recently accepted head, then node id; amendment "overnight R22"), never by the shared index's
BM25, which only picks the candidates (every one is read, up to 4096 candidate chunks); its
index on `search_chunks_v1.text` is built and refreshed by the writer in `indexRevisionChunks`.
`kb_searchKnowledgeSemantic` embeds the query with the configured Ollama model
(`EMBEDDING_MODEL`, whose name is also the default profile) and ranks READY chunk vectors of that
one embedding profile by squared L2 `distance`. The two are never fused. CLI:
`search --bank B --query Q --mode keyword|semantic`; a bare `search` stays the legacy memories
search (`--mode text|vector`, default `text`).

HTTP surface:

```text
GET  /health                              GET  /api/health?bank=
GET  /api/memories?bank=                  POST /api/memories
GET  /api/search?bank=                    POST /api/backfill
POST /api/reindex                         POST /api/knowledge/:bank/:method
POST /mcp/:bank                           POST /mcp/:bank/:workspace  (always 400)
GET  /  /knowledge.html  /v2/*            static assets
```

`POST /api/knowledge/:bank/:method` is the HTTP leg of the 46 `kb_*` methods above — one
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

Friendly aliases wrap a `kb` call with plain flags for the daily loop (`--bank` still required):

```bash
bun app/cli.ts peer add --bank example --name nat
bun app/cli.ts session add --bank example --name standup
bun app/cli.ts message append --bank example --session standup --peer nat --content 'hello'
bun app/cli.ts nodes list --bank example --limit 20
bun app/cli.ts nodes list --bank example --limit 20 --history   # include retired/superseded, labelled
bun app/cli.ts context get --bank example --peer nat --session standup
bun app/cli.ts chat ask --bank example --peer nat --session standup --question 'what happened?'
```

These are thin: they map a handful of flags onto the method's known closed-key request shape (minting a
`peer_id`/`session_id`/`public_id` when one is not given) and otherwise do no validation the server does
not already do more strictly. `node create`/`node revise` (`publishRevision`) are deliberately not aliased
— that request is a governed revision envelope, not a flat object — use `kb publishRevision --json/--file`
directly. Implementation lives under `app/cli/` (one function per file); `app/cli.ts` stays the entry point.

## Verification and remaining scope

`bun run --cwd app/server test` runs the **entire** 68-file suite in one process
(measured 2026-09-26: 1123 tests, ~497s wall, almost serial). Prefer one of:

```bash
bun run --cwd app/server test:fast          # <35s-per-file tier only
bun run --cwd app/server test:<kernel>      # e.g. test:context, test:taxonomy, test:auth
TEST_SHARDS=4 bun run --cwd app/server test:parallel   # full suite, sharded across N `bun test` processes
bun run --cwd app/server typecheck
bun run --cwd app/server build
bun test app/cli.test.ts

# Python (app/migrate-py) — there is no pytest config or dependency; this is the real command:
uv sync --project app/migrate-py --frozen
PYTHONPATH=app/migrate-py/src app/migrate-py/.venv/bin/python \
  -m unittest discover -s app/migrate-py/tests -v

# `discover` does NOT reach tests/fixtures/*-v1/ (neither directory has an
# __init__.py; both files document this and give this exact command). Run
# them explicitly, with the ResourceWarning-as-error the fixture-lane contract
# requires (app/docs/contracts/taxonomy-write-v1.md:98). Measured: 139 OK
# (discover) + 17 OK (publication) + 22 OK (taxonomy).
cd app/migrate-py
PYTHONPATH=src:tests .venv/bin/python -W error::ResourceWarning \
  tests/fixtures/publication-v1/test_export_publication_fixture.py -v
PYTHONPATH=src:tests .venv/bin/python -W error::ResourceWarning \
  tests/fixtures/taxonomy-v1/test_export_taxonomy_fixture.py -v
```

`app/benchmarks` has its own 123 Python tests (`test_harness_*.py`, `test_retrieval_metrics.py`)
outside both discovery roots above. Run them with the same venv:
`cd app/benchmarks && ../migrate-py/.venv/bin/python -m unittest discover -s . -p 'test_*.py'`.

`.github/workflows/ci.yml` runs this same set (typecheck, build, `test:parallel` with
`TEST_SHARDS=4`, the Python `unittest discover` suite plus the two explicit fixture
suites above, the `app/benchmarks` tests, and the `app/ui/v2` build) on every push and
pull request.

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
commit/recovery (#26) are **closed** — see AGENTS.md for what's measured working versus
still gated. Taxonomy (#27), peer/message/trace provenance (#28), lifecycle (#29), derived
search (#30), the unified API/MCP/CLI contract (#31), context/chat (#32), the UI (#33) and
migration/release proof (#34) remain open, alongside the defects AGENTS.md's work map
lists (#85, #87, #89, #102, #103, #105, #75). `DESIGN.md` is a publication-time snapshot of
#36 from 2026-09-20 and is now stale on several headline claims (auth, table counts, tool
counts) — consult fresh source, this file, AGENTS.md and `docs/overnight/DECISIONS.md`
instead.
