# arra-oracle-v4 POC — the shape

Measured 11:41 +07, Fri 18 Sep 2026 from the running system. Every number was read off a
live process or off disk; none is carried from the spec.

```
        arra-oracle-v4 POC        measured 11:41 +07  Fri 18 Sep 2026

  +--------------------------------------------------------------------------+
  | SCHEMA OWNER -- writes once, then never reads                            |
  +--------------------------------------------------------------------------+
  | Rust  arra-migrate    migrate/src/main.rs  72 L    lancedb 0.38.0        |
  | binary 641 MB (debug)  <-- DataFusion is statically linked               |
  +--------------------------------------------------------------------------+
                     |
                     |  create_empty_table(schema), 18 fields, idempotent
                     v
  +--------------------------------------------------------------------------+
  | THE ONLY STORE     data/memories.lance     128 KB   v8   8 manifests     |
  +--------------------------------------------------------------------------+
  | 18 fields  ·  5 rows  ·  5 embedded  ·  0 pending                        |
  | content_idx : FTS (icu)     <-- icu segments Thai; `simple` cannot       |
  | embedding : fixed_size_list<float>[1024]  NULLABLE                       |
  |                                           ^ why backfill is possible     |
  |                                                                          |
  | no libSQL · no second store · no Python worker · no IPC hop              |
  +--------------------------------------------------------------------------+
                     ^                                   ^
                     |  openTable() PINS A VERSION       |  mergeInsert("id")
                     |  checkoutLatest() each access (!) |  vectors only
                     |                                   |
  +--------------------------------------------------------------------------+
  | TS BACKEND     server/  244 L     Bun + Hono     :3939  FRESH            |
  +--------------------------------------------------------------------------+
  | db.ts    158 L   opens what Rust wrote, never defines it                 |
  | embed.ts  38 L   one interface; Ollama now, CF / OpenAI swappable        |
  | index.ts  48 L                                                           |
  |                                                                          |
  | POST /api/memories   insert; embeds inline, NULL if embedder down        |
  | GET  /api/search     mode=text -> FTS(icu)  |  mode=vector -> 1024-d     |
  | POST /api/backfill   WHERE embedding IS NULL -> embed -> mergeInsert     |
  | POST /api/reindex    GET /api/memories    GET /api/health                |
  +--------------------------------------------------------------------------+
                     |
                     |  fetch()
                     v
  +--------------------------------------------------------------------------+
  | EMBEDDER -- the only box outside this machine's filesystem               |
  +--------------------------------------------------------------------------+
  | Ollama  :11434  FRESH    mxbai-embed-large  1024-d                       |
  | weak on Thai semantics (!)  -- Thai query ranked the Thai row LAST of 4  |
  | optional by design: it goes down, rows still land, backfill catches up   |
  +--------------------------------------------------------------------------+

  THREE READERS OF THE SAME BYTES
  +--------------------------------------------------------------------------+
  | own UI       public/index.html  155 L   :3939   health / write / search  |
  | SmooSense    Apache-2.0, uv tool         :8123  FRESH   own lancedb 0.39 |
  | lance-data-viewer   MIT, Docker only     colima DOWN      XX             |
  |                     image 0.36 < data 0.38  -- reader older than writer  |
  +--------------------------------------------------------------------------+

  TOOLING -- needs no server, and that is the point
  +--------------------------------------------------------------------------+
  | just   mod migrate | server | data | view                                |
  |        source_directory(), NOT justfile_directory()  (!)                 |
  |                                                                          |
  | just data schema / versions / rows / disk                                |
  |      -> uv run lance_peek.py   (PEP 723, deps declared inline)           |
  |      -> reads the .lance DIRECTORY, so it can never serve a stale        |
  |         pinned version -- the one reader that always tells the truth     |
  +--------------------------------------------------------------------------+

  LEGEND
    FRESH = verified responding this session     XX = blocked, not running
    (!)   = trap or finding, explained below     L  = lines of source
    every size and count measured from the live system; none estimated
```

## What the picture shows that the prose did not

**The store is one box, and that is the whole argument.** SPEC.md §4.4–4.7 budgets a page
for a Python-owned Lance worker, an IPC hop and a language boundary — all of which exist
because `@lancedb/lancedb`'s native bindings cannot run inside a Cloudflare Worker. Drawn
out, the constraint has nothing to attach to: nothing here runs in a Worker. `embedding` is
just a column, and the second store never appears.

**Both arrows into the store come from different languages, which is exactly why the
snapshot bug hid.** Rust writes the schema once and never reads; TS writes rows forever.
Until both had written, a cached `Table` handle looked correct. The diagram puts
`checkoutLatest()` on the only edge that could ever go stale — and that edge only exists
because the two writers are separate processes.

**The one box outside the filesystem is the one box that is optional.** Everything else is
a local file or a local process. That is why `embedding` is nullable and why backfill
exists: the design absorbs the embedder being down. Its `(!)` is a quality finding — a Thai
query ranked the only Thai row last of four — not an availability one.

**Three readers, one of which needs nothing running.** UI, SmooSense and `just data schema`
all point at the same directory, but only the tooling path bypasses every long-lived handle
in the system. That is what made it trustworthy this morning when the server's own row
count was the thing in doubt.

**641 MB of debug binary from 72 lines of Rust.** Lance statically links DataFusion, so the
schema owner is three orders of magnitude larger than the schema it owns. Irrelevant to
correctness; relevant to anyone planning to containerise this.
