# Current architecture and historical evidence

The full target is [DESIGN.md](../DESIGN.md); setup is [README.md](README.md).
The original 18 September Rust/Hono/1024-d diagram is preserved verbatim in
[docs/history/ARCHITECTURE-spike-2026-09-18.md](docs/history/ARCHITECTURE-spike-2026-09-18.md).
Its runtime numbers are historical, not current health claims.

```text
SCHEMA OWNER                       APPLICATION OWNER
Python LanceModel                  TS / Bun / Elysia
15 physical tables                 HTTP / MCP / CLI
Arrow declarations                 validation / scope / writes
          |                                |
          +------------+-------------------+
                       v
                canonical LanceDB
                local by default
                optional R2 config
                       |
                       +--> nullable embeddings (all-minilm/384 default)
                       +--> ICU full-text index

TARGET, NOT CURRENT PHYSICAL SCHEMA
messages + peers + sessions -> revisionable nodes + pinned evidence
                                         |
                             derived revision/profile search
                                         |
                             bounded context -> optional chat
```

There is no libSQL store, required Python subprocess per CRUD, or active Rust schema owner. SQL foreign keys and cross-table transactions are not supplied by Python type declarations. #23 must freeze codecs/digests; #26 must prove revision publication/retry/recovery; R2 config is not a multi-writer guarantee. A proposed immutable revision-envelope refinement remains under review and is not silently adopted by this diagram.

The server stays localhost-only while auth is absent. Connected MCP proves a transport is responding, not the complete target feature set or production safety.
