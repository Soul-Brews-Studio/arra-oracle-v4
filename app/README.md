# arra-oracle-v4 — POC app

Python owns the schema, declared as LanceModels. TypeScript opens what the migration
wrote, then inserts, embeds and queries it. One LanceDB directory on disk, no second
store, no language boundary in the write path.

```
app/
  migrate-py/  Python  OWNS THE SCHEMA. LanceModel declarations -> tables.
  migrate-rs/  Rust    retained, no longer the owner. Same 18 fields.
  server/      Bun     Hono API + UI. Opens the table, never defines it.
  data/        LanceDB dataset, written by the migration, read+written by TS.
```

The schema is declared once, as pydantic models that carry their own Arrow types
(`migrate-py/src/arra_migrate/models.py`), so there is no separate `pa.schema([...])`
to keep in sync with the model.

## Run it

```bash
# 1. schema (idempotent; `just migrate reset` recreates)
just migrate run

# 2. backend + UI
just server install && just server start
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

## Why Python owns the schema, and Rust does not

Rust worked. It was replaced for cost, not correctness: **8.1 GB of build artifacts and a
612 MB debug binary, from a 3m31s cold build, for 72 lines that run once.** The strong
typing that justified it buys little here — a schema is a data declaration, not logic, so
there is no invariant for the type system to enforce. It would earn its place if the
migration layer grew validation, ordering, or transforms.

The swap was safe because **Lance is language-neutral**. `just migrate check` was run
against the table Rust had already created and reported `ok` — the same 18 fields, the same
types. Python then created the table from scratch in a scratch directory and TypeScript
opened it unchanged: 18 fields, `FixedSizeList[1024]<Float32>`, nullable. Three languages,
one directory, no conversion step.

`migrate-rs/` is kept rather than deleted. `just migrate rs-run` still works, and it is the
proof of that language-neutrality claim rather than just an assertion of it.
