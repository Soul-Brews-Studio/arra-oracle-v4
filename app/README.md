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
     no reviewed migration CLI)                  context/evidence — 31 kb_*
                                                  methods over HTTP + MCP
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
| `server/src/` | Elysia HTTP/MCP, storage and application behavior. `src/knowledge/registry.ts` is the 31-method target19 method table; `src/mcp/tools.ts` is the MCP catalogue (8 memory + 31 `kb_*` = 39 tools) |
| `cli.ts` | CLI adapter over the 13 legacy MCP/HTTP methods only — no `kb_*` leg yet (#31) |
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

Startup also requires Bun exactly `1.3.14` and Elysia exactly `1.4.30`, or it refuses. It
creates the ICU content index over the legacy `memories` table only when missing; an
existing index is retained. Explicit reindex remains a global maintenance operation, and
(like backfill) needs a bearer token with global `maintenance:*` grants.

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

Every route needs `Authorization: Bearer <64 lowercase hex>` except `/health`. The
bearer's policy grants (`content:read`/`write`, `audit:read`, `diagnostics:read`,
`maintenance:backfill`/`reindex`) gate every method; see `write_dev_policy.py` above for
the dev shape.

MCP endpoint: `/mcp/:bank`, with bank = `workspaces.name` (not credentials). `tools/list`
returns **39 tools**, filtered to what the caller's token grants: 8 legacy memory tools
plus 31 `kb_<method>` tools generated from `src/knowledge/registry.ts` (measured live,
`status` tool reports `"tools": 39`):

```text
remember recall get_memory list_memories
bank_info call_log call_stats status

kb_getAcceptedHead kb_listAcceptedHistory kb_listNodes kb_publishRevision
kb_getVocabulary kb_getTerm kb_createVocabulary kb_createTerm kb_renameTerm
kb_retireTerm kb_reparentTerm kb_seedReservedVocabularies
kb_getPeer kb_getSession kb_getMessage kb_listMessages kb_listPeers kb_listSessions
kb_getReadCursor kb_registerPeer kb_registerSession kb_joinSession kb_appendMessages
kb_advanceReadCursor kb_getContext kb_listMcpCalls kb_listConnections kb_answerChat
kb_getRevisionAssociations kb_scanDependents kb_reconcileRevisionAssociations
```

The knowledge kernel actually has 44 methods; the other 13 (session links, traces,
lifecycle, search-chunk write/index) have no `kb_*` tool and no HTTP route on purpose
(`registry.ts:18-35`) — reachability is tracked by #28/#29/#30/#31.

HTTP surface:

```text
GET  /health                              GET  /api/health?bank=
GET  /api/memories?bank=                  POST /api/memories
GET  /api/search?bank=                    POST /api/backfill
POST /api/reindex                         POST /api/knowledge/:bank/:method
POST /mcp/:bank                           POST /mcp/:bank/:workspace  (always 400)
GET  /  /knowledge.html  /v2/*            static assets
```

`POST /api/knowledge/:bank/:method` is the HTTP leg of the 31 `kb_*` methods above — one
RPC-style route per method, body `workspace_name` must equal `:bank`, capped at 1 MiB
(the MCP leg caps at 256 KiB). Backfill and reindex are global maintenance operations in
this prototype; a `?bank` on either gives 400. Do not infer bank isolation from an
unrelated CLI `--bank`. The obsolete extra `/mcp/:bank/:workspace` segment must not be
interpreted as a second tenant/context boundary; the repaired handler rejects it
explicitly.

```bash
export ARRA_URL=http://127.0.0.1:3939
export ARRA_TOKEN="$(cat "$ROOT/auth/dev-token.txt")"

bun app/cli.ts help
bun app/cli.ts status --bank default --pretty
bun app/cli.ts remember --bank default --content 'A reviewed fact' --peer neo --subject nat
bun app/cli.ts recall --bank default --query 'reviewed' --mode text
```

Every command except `health` needs `ARRA_TOKEN` (or a bearer via `--url`'s target) —
measured: with no token, `ARRA_TOKEN must be exactly 64 lowercase hex characters`, exit 1.
The CLI covers the 13 legacy backend commands plus help; it does not wrap the 31
`/api/knowledge` / `kb_*` methods above (call those over HTTP or MCP; #31 tracks giving
the CLI a knowledge leg). It validates arguments, forwards subject attribution, and exits
nonzero for HTTP/JSON-RPC/MCP tool errors. It preserves JSON envelopes and is not an
installed global binary.

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
```

`.github/workflows/ci.yml` runs this same set (typecheck, build, `test:parallel` with
`TEST_SHARDS=4`, the Python suite, and the `app/ui/v2` build) on every push and pull
request.

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
