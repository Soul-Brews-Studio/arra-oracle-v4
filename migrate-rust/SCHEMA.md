# `memories` — LanceDB table, as actually compiled

Measured 10:51 +07, Fri 18 Sep 2026, by running the real binary — not copied from
SPEC.md prose. Source: `migrate-rust/src/main.rs` -> `target/debug/arra-v4-migrate`.
On disk: `data/memories.lance`, 20K, 2 manifest versions (second run = Overwrite,
old manifest still present — Lance keeps every version, nothing deleted).

```
memories  (Arrow schema, LanceDB-native)
┌──────────────────────────────────────────────────────────────────────┐
│ id                 Utf8                     NOT NULL  app-level PK   │
│ name               Utf8                     NOT NULL                │
│ workspace_name     Utf8                     NOT NULL  isolation key  │
│ session_name       Utf8                     null                    │
│ peer_name          Utf8                     null                    │
│ subject_peer_name  Utf8                     null                    │
│ type               Utf8                     NOT NULL                │
│ content            Utf8                     NOT NULL                │
│ embedding          FixedSizeList<f32,1024>  null      NATIVE *      │
│ created_at         Timestamp(us)            NOT NULL                │
│ valid_from         Timestamp(us)            null                   │
│ valid_to           Timestamp(us)            null                   │
│ sync_state         Utf8                     NOT NULL                │
│ superseded_by      Utf8                     null                   │
│ superseded_at      Timestamp(us)            null                   │
│ is_active          Boolean                  NOT NULL  OPEN #2 ?    │
│ h_metadata         Utf8                     null      json-as-string│
│ internal_metadata  Utf8                     null      json-as-string│
└──────────────────────────────────────────────────────────────────────┘
  17 fields, 1 table.  15 other v4 tables (discussion #14) not built.

  *  embedding lives ON this table now, native FixedSizeList<f32,1024> --
     no separate F32_BLOB/libSQL column, no LanceDB-Python worker, no
     language boundary. LanceDB IS Rust already; SPEC.md §4.5.6's whole
     IPC-hop subsection has nothing left to guard against here.
  ?  is_active vs tier (issue #2) still unresolved upstream -- carried
     across as a plain bit, unchanged, pending that decision.
```

## What this reveals that the prose didn't

Discussion #14's ASCII (drawn from SPEC.md, pre-code) shows `memories` sitting on
libSQL with a *separate* Lance dataset reachable only through a Python worker and an
IPC hop (§4.5.6). This diagram is drawn from a compiled, running artifact instead,
and the shape is simpler than the spec assumed: with LanceDB accessed natively from
Rust, `embedding` is just another column — the language-boundary subsection the spec
spent a page justifying (§4.4–4.7) doesn't apply to this path at all. Column count
matches #14's memories table (15 + 2 JSON bags) exactly, plus one native vector
column; `is_active` was carried across unchanged rather than resolved, so it's still
an open question, not a decision made by writing the migration.
