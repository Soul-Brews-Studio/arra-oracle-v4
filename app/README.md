# arra-oracle-v4 — active local app

Read [the current guide](../AGENTS.md) and [full target design](../DESIGN.md).
This is an unauthenticated local prototype, not the completed 19-table design.

```text
Python LanceModel registry (15 tables / 152 fields; memories=20)
                          |
                          v
                    local LanceDB
                          ^
                          |
           TypeScript / Bun / Elysia :3939
                 HTTP + MCP + source-run CLI
```

## Ownership and paths

| Path | Responsibility |
|---|---|
| `migrate-py/src/arra_migrate/models/` | Active Python schema registry |
| `migrate-py/src/arra_migrate/__main__.py` | Table creation and drift checks |
| `server/src/` | Elysia HTTP/MCP, storage and application behavior |
| `cli.ts` | CLI adapter over current MCP/HTTP methods |
| `cli.test.ts`, `server/test/` | Regression tests; isolated fixtures/stubs |
| `migrate-rs/`, root `migrate-rust/` | Historical experiments, not schema owners |
| `docs/history/` | Original dated POC reports, preserved verbatim |

The Python registry defines Arrow types; opening it from TypeScript does not add SQL foreign keys, uniqueness, authorization or cross-table transactions. Those need explicit application contracts and tests.

## Local run with an isolated dataset

With this checkout's existing Python venv and Bun dependencies installed, from repository root:

```bash
# Choose a NEW isolated local directory; do not reset an existing bank.
export ARRA_DATA_DIR="$(mktemp -d)"
app/migrate-py/.venv/bin/python -m arra_migrate
app/migrate-py/.venv/bin/python -m arra_migrate --check

# Foreground process, localhost only; do not run a second writer on the same data.
bun run --cwd app/server start
```

Startup creates the ICU content index only when missing; an existing index is retained. Explicit reindex remains a global maintenance operation.

The same absolute `ARRA_DATA_DIR` must reach migration and server. Default relative `../data` depends on cwd and is unsuitable for ambiguous scripted runs. Never use `ARRA_RESET=1` on existing data casually. Optional S3/R2 configuration exists but is not proof of production concurrency or auth.

Default embedder configuration is Ollama `all-minilm`, 384 dimensions, with `OLLAMA_URL`, `EMBEDDING_MODEL`, and `EMBEDDING_DIMENSIONS` overrides. Do not change a live table's dimension/profile through environment settings and assume compatibility. Ollama is an HTTP service; locality depends on the configured URL. No cloud call is needed for the regression suite.

## Current interfaces

MCP endpoint: `/mcp/:bank`, with bank = `workspaces.name` (not credentials).

```text
remember recall get_memory list_memories
bank_info call_log call_stats status
```

HTTP surface:

```text
GET  /health                 GET  /api/health
GET  /api/memories            POST /api/memories
GET  /api/search              POST /api/backfill
POST /api/reindex
```

Backfill and reindex are global maintenance operations in this prototype. Do not infer bank isolation from an unrelated CLI `--bank`. The obsolete extra `/mcp/:bank/:workspace` segment must not be interpreted as a second tenant/context boundary; the repaired handler rejects it explicitly.

```bash
bun app/cli.ts help
bun app/cli.ts status --bank example --pretty
bun app/cli.ts remember --bank example --content 'A reviewed fact' --peer neo --subject nat
bun app/cli.ts recall --bank example --query 'reviewed' --mode text
```

The CLI covers 13 current backend commands plus help. It validates arguments, forwards subject attribution, and exits nonzero for HTTP/JSON-RPC/MCP tool errors. It preserves JSON envelopes. It is not an installed global binary and does not implement future node/context/peer APIs.

## Verification and remaining scope

```bash
bun test app/cli.test.ts
bun run --cwd app/server test
bun run --cwd app/server typecheck
bun run --cwd app/server build
```

The typecheck script uses the already-installed TypeScript compiler; this patch adds no dependency. `skipLibCheck` excludes dependency declaration diagnostics, not our source/tests.

Inspect the actual test output; a help check is not a live backend test, and passing current regressions is not proof that the future schema is implemented. Use temporary data and stub model calls. Keep existing app data, v3, and other agents' services untouched.

The roadmap is [#22](https://github.com/Soul-Brews-Studio/arra-oracle-v4/issues/22). Auth, target schema codecs, immutable revision commit/recovery, taxonomy, peer/message provenance, context/chat, UI and migration/release gates remain unfinished. `DESIGN.md` is a publication-time snapshot of #36; consult fresh source/tests for newer repairs.
