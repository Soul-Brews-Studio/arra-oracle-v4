# Foundation repair verification — 2026-09-20

Scope: current 15-table localhost spike, issues #24/#31; not the complete #36 design.

## Reproduce

From repository root, with the existing Bun dependencies and TypeScript compiler installed:

```sh
bun run --cwd app/server test
bun run --cwd app/server typecheck
bun run --cwd app/server build
git diff --check
```

Measured after integration: **57 tests / 208 assertions, zero failures**, strict TypeScript pass, Bun build pass, diff hygiene pass. Dependency declarations are excluded with `skipLibCheck`; app, tests and CLI are checked. No new product dependency was added. This is a new focused regression suite, not an assertion that all historical or future gates pass.

Covered: two-bank audit/stat scope, log ordering/ties before limit, transport identity separation, redaction, missing scope, get-by-ID beyond the old 1000-row cap, filter-before-limit, subject/active filters, protected metadata exclusion, HTTP/MCP/CLI validation, exact unsafe-int64 serialization, pending content ACK without model I/O, explicit backfill failure/success, finite Float32 vector validation, initial/idempotent ICU index creation, scoped keyword retrieval of newly appended rows, and current HTML request/failed-save behavior.

CLI: all 13 current commands exercised against a loopback stub, including verbs/query scope; invalid arguments and MCP errors exit nonzero. UI: VM/DOM request-contract tests, **not real-browser E2E**. Backend writes use fresh scratch LanceDB fixtures; model calls are stubbed.

## Live local MCP reload

The existing isolated worktree dataset was retained. Local server reloaded as `arra-oracle-v4 26.9.20-alpha.1625`, bound to `127.0.0.1:3939` only. MCP SDK initialize/ping/eight-tool list and empty-bank read passed. Native MCP status passed; native keyword recall returned `[]` after the newly discovered missing-index startup defect was fixed. Live CLI list passed, missing-memory MCP error produced exit 1, and the ignored extra workspace path returned HTTP 400. These checks did not insert test knowledge into the live bank.

## Development MCPs

- Serena: project-local override, durable isolated metadata, read-only product project; initialize/ping/23-tool list and symbol overview passed through MCP SDK.
- CodeGraph trial: MIT upstream `suatkocar/codegraph` pinned `856739a1a528cfae9f9232566ae5c043ef8cfaf5`, installed without embeddings. No init/hooks/watch/HTTP/upload. Project-local stdio config limits categories to Repository/Search/CallGraph; 21 tools and disabled-tool rejection tested. Fresh full index: 40 source files, all stored hashes matched at verification.
- Graph caveat: known handleMcp usages exist while callers reports zero. Graph absence is **not** proof; cross-check Serena/source. Force rebuild after edits/deletes/renames; no unqualified incremental-freshness guarantee.
- Both development MCPs are configured and direct-SDK-tested, **not claimed exposed in the already-running native tool registry** until client reload evidence exists.

## Remaining gates

Auth/privileged global maintenance, full lifecycle eligibility, embedding-profile identity, cursor pagination, physical #23 codecs/manifest, immutable revision publication/retry/recovery, taxonomy, peer/messages/provenance APIs, bounded context/chat, full Explorer UI, copy migration, R2/concurrency and release proof remain incomplete. Python lint/historical Rust issues reported earlier were not repaired or reclassified as passing. No v3 migration or shared dataset reset occurred.

Code review approved the bounded repairs after fixing internal metadata disclosure. It did not approve the whole roadmap as complete. No issue should be closed solely because this file exists.

Written by Codex (AI), speaking as itself.
