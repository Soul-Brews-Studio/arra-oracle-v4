# arra-oracle-v4 — POC app

Rust owns the schema. TypeScript opens what Rust wrote, inserts, embeds and queries it.
One LanceDB directory on disk, no second store, no language boundary in the write path.

```
app/
  migrate/   Rust   creates the `memories` table. Never queried from here.
  server/    Bun    Hono API + UI. Opens the table, never defines it.
  data/      LanceDB dataset, written by Rust, read+written by TS.
```

## Run it

```bash
# 1. schema (idempotent; ARRA_RESET=1 recreates)
cd migrate && cargo run

# 2. backend + UI
cd ../server && bun install && bun run src/index.ts
# http://127.0.0.1:3939
```

Embeddings come from a local Ollama (`mxbai-embed-large`, 1024-d — the dimension the
column was created with). Override with `OLLAMA_URL`, `EMBEDDING_MODEL`,
`EMBEDDING_DIMENSIONS`. No key, no network.

## API

| | |
|---|---|
| `GET /api/health` | row counts, embedded vs pending, table version, indices, embedder status |
| `GET /api/memories?bank=&limit=` | list |
| `POST /api/memories` | `{name, content, workspace_name?, type?}` — embeds inline, falls back to null |
| `GET /api/search?q=&mode=text\|vector&bank=&limit=` | FTS (icu) or semantic (1024-d) |
| `POST /api/backfill?batch=32` | embed rows where `embedding IS NULL` |
| `POST /api/reindex` | build/replace the FTS index on `content` |

## Three things this POC establishes

**Index first, embed later works.** `embedding` is nullable and *not* bound into the
Lance schema as an embedding function. Rows land with text only; `POST /api/backfill`
fills vectors afterwards via `mergeInsert("id")`. Binding an embedding function into the
schema (the `LanceSchema` + `sourceField/vectorField` pattern) would make every write
block on an embedding call — the un-transactional write path SPEC.md §4.6 already flags.

**Tenant isolation holds on the search path.** `?q=ความ` returns rows from two banks;
adding `&bank=default` drops the foreign one. Not just a write-time constraint.

**A Table handle is a pinned snapshot, not a live view.** Caching the handle made the
server report 4 rows while the table held 5 — writes from another process stayed
invisible. `checkoutLatest()` before each access is what makes Rust-writes/TS-reads
actually work. This is the kind of thing only running it finds.

## Measured, worth knowing

`mxbai-embed-large` is weak on Thai semantics: a Thai query about memory
(`หน่วยความจำภาษาไทย`) ranked the only Thai-heavy row **last** of four, while the same
row is the top FTS hit for `ความทรงจำ`. On this corpus FTS beats vectors for Thai —
consistent with the fleet's prior measurement (MRR 0.765 FTS vs 0.099 vectors) and
directly relevant to spike S8 (#7). A Thai-capable embedder (bge-m3) is the thing to
test before trusting semantic search on Thai content.

Also: LanceDB's `icu` tokenizer segments a Thai query into words and ORs them, so
`ความทรงจำ` matches any row containing `ความ`. Lesson 8's "icu matches exactly" held
only because nothing else in that corpus shared the token.
