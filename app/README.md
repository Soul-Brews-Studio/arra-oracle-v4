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
| ~~`migrate-rs/`, root `migrate-rust/`~~ | Rust experiments, removed — never schema owners. Recoverable from git history |
| ~~root `index-ts/`, `query-ts/`~~ | Spikes over the removed Rust dataset, removed — no producer, no importer. Recoverable from git history |
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
POST /api/reindex             POST /api/knowledge/:bank/:method
```

Backfill and reindex are global maintenance operations in this prototype. Do not infer bank isolation from an unrelated CLI `--bank`. The obsolete extra `/mcp/:bank/:workspace` segment must not be interpreted as a second tenant/context boundary; the repaired handler rejects it explicitly.

`/api/knowledge/:bank/:method` (#31) dispatches to whichever methods `app/server/src/knowledge/registry.ts` names — publication, taxonomy, context and evidence kernels. It is also exposed as `kb_<method>` MCP tools with a `{payload:{...}}` wrapper.

```bash
bun app/cli.ts help
bun app/cli.ts status --bank example --pretty
bun app/cli.ts remember --bank example --content 'A reviewed fact' --peer neo --subject nat
bun app/cli.ts recall --bank example --query 'reviewed' --mode text
```

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
bun app/cli.ts context get --bank example --peer nat --session standup
bun app/cli.ts chat ask --bank example --peer nat --session standup --question 'what happened?'
```

These are thin: they map a handful of flags onto the method's known closed-key request shape (minting a
`peer_id`/`session_id`/`public_id` when one is not given) and otherwise do no validation the server does
not already do more strictly. `node create`/`node revise` (`publishRevision`) are deliberately not aliased
— that request is a governed revision envelope, not a flat object — use `kb publishRevision --json/--file`
directly. Implementation lives under `app/cli/` (one function per file); `app/cli.ts` stays the entry point.

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
