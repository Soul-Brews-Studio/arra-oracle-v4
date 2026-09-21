# Schema as built — 19 tables, 228 columns

Measured 2026-09-21 from `app/server/src/publication/storage.ts` (`TARGET_SCHEMA`)
and `app/migrate-py/src/arra_migrate/target_v1/` (`TARGET_TABLE_NAMES`), not from
`SPEC.md` and not from any discussion.

Every earlier ASCII in this repo's discussions describes a **different** database
than the one the TypeScript runtime will open. This file is the correction, and
the drift is named in section 0 rather than quietly fixed.

---

## 0 · Why the old ASCII is wrong

```text
╔══════════════════════════════════════════════════════════════════════════════╗
║  THREE REGISTRIES, TWO SHAPES                          measured 2026-09-21   ║
╚══════════════════════════════════════════════════════════════════════════════╝

  arra_migrate.models.TABLES ............ 15 tables   ACTIVE Python registry
  arra_migrate.target_v1.TARGET_TABLE_NAMES  19        isolated candidate
  storage.ts TARGET_SCHEMA .............. 19 tables   what the server ENFORCES

  only in the 15 ...  memories · memory_terms
  only in the 19 ...  nodes · node_revisions · node_revision_terms
                      revision_links · session_links · search_chunks_v1

                        15 - 2 + 6 = 19      (not 15 + 4)
```

The single change behind all of it: **`memories` no longer exists.** One mutable
row holding both identity and content was split into `nodes` (identity, and a
pointer to the current revision) plus `node_revisions` (immutable content, one
row per version). `memory_terms` followed it, becoming `node_revision_terms` —
taxonomy now attaches to a REVISION, so re-tagging is a new revision rather than
an in-place edit of history.

Discussions #14, #18, #21 and #36 all predate or only partly record this:

| discussion | says | status |
|---|---|---|
| #14 | 16 tables specced, `memories`, `memory_terms`, `delivery_refs` | superseded |
| #18 | 15 tables measured on disk, `memories` 18 cols | superseded |
| #21 | 19-table design | shape agreed, columns moved since |
| #36 | "15 built tables / 19 proposed" | the 19 are now BUILT and enforced |

### Where the drift came from

Relic shows every ASCII in this repo was drawn in v4-codex sessions on
2026-09-19, and #14 states its own source in its first line: "Drawn from
`SPEC.md` v26.9.18-alpha.915". The diagrams were never wrong about their
source. The source moved out from under them.

Measured in this worktree on 2026-09-21:

```text
                        memories /        nodes /
                        memory_terms      node_revisions
  SPEC.md  v26.9.20 ....... 27 ................. 0
  DESIGN.md ................ 9 ................ 18
```

`SPEC.md` still describes the `memories` model end to end and does not mention
node revisions once, while `DESIGN.md` describes the node/revision model. Two
documents in the same repository specify two different databases, and the ASCII
was drawn from the stale one. Correcting the diagram alone would leave that
intact, so the diagram is not the fix -- reconciling SPEC.md is.

`storage.ts` does not merely prefer the 19-table shape — it refuses to open a
dataset that is not exactly it, checking every field name, Arrow type and
nullability before any mutation. So "proposed" is no longer accurate for the
TypeScript side. The ACTIVE Python registry is still the 15-table baseline; that
gap is real and is the thing to decide on, not a documentation bug.

---

## 1 · The ledger

```text
╔══════════════════════════════════════════════════════════════════════════════╗
║  arra-oracle-v4 — SCHEMA AS BUILT             19 tables · 228 columns        ║
║  source: storage.ts TARGET_SCHEMA · golden order                            ║
╚══════════════════════════════════════════════════════════════════════════════╝

  TIER 1 · HONCHO-COMPATIBLE                         cols   nullable
    workspaces ..................................... 7        4
    peers .......................................... 7        3
    sessions ....................................... 8        3
    session_peers .................................. 7        3
    messages ....................................... 20      10
    session_links .................................. 8        2   NEW
                                                     ──
                                                     57

  TIER 2 · KNOWLEDGE  (replaces `memories`)
    nodes .......................................... 5        1   NEW
    node_revisions ................................. 26      10   NEW
    node_revision_terms ............................ 8        1   NEW
    revision_links ................................. 12       4   NEW
    supersede_log .................................. 16       9
    vocabularies ................................... 13       3
    terms .......................................... 10       3
                                                     ──
                                                     90

  TIER 3 · INVESTIGATION + SEARCH
    traces ......................................... 20      12
    trace_hits ..................................... 12       6
    search_chunks_v1 ............................... 20       7   NEW
                                                     ──
                                                     52

  TIER 4 · OPERATIONS
    mcp_calls ...................................... 12       6
    connections .................................... 12       3
    read_cursors ................................... 5        1
                                                     ──
                                                     29

                                            TOTAL   228 columns
```

---

## 2 · Entity map

```text
                        ╔═══════════════════════╗
                        ║      workspaces       ║   name is the FK target
                        ║   ( = "bank" in URLs) ║   everywhere — never .id
                        ╚═══════════╤═══════════╝
                                    │
           workspace_name NOT NULL on all 18 other tables
                                    │
   ┌───────────┬────────────┬───────┴────┬───────────┬────────────┐
   │           │            │            │           │            │
   ▼           ▼            ▼            ▼           ▼            ▼
 peers     sessions       nodes     vocabularies   traces      mcp_calls
   │           │            │            │           │        connections
   │           │            │            ▼           │
   │           │            │          terms ◄───────┼── parent_id (self)
   │           │            │            │           │
   │           │            ▼            │           ├── trace_hits
   │           │     node_revisions      │           ├── parent_id ─┐ tree
   │           │      revision_no N      │           ├── prev_id ───┤ chain
   │           │      immutable          │           │   ◄──────────┘
   │           │            │            │           │
   │           │            ├─ node_revision_terms ──┘
   │           │            │     position-ordered, SNAPSHOTS the term
   │           │            │     name and label at publish time
   │           │            │
   │           │            ├─ revision_links
   │           │            │     target_kind / target_key — evidence,
   │           │            │     including targets outside this database
   │           │            │
   │           │            └─ search_chunks_v1
   │           │                  embedding fixed_size_list<float32>[384]
   │           │                  DERIVED. save-first, embed-after:
   │           │                  status / attempts / error_code carry
   │           │                  the retry state on the chunk row itself
   │           │
   ├───────────┤
   ▼           ▼
 session_peers                       nodes.current_revision_id ──┐
   │  joined_at / left_at                                        │
   │  leaving is a TIMESTAMP, never a DELETE                     ▼
   │                                                      node_revisions
   ├─ messages ── in_reply_to ─┐                                 ▲
   │    ▲                      │  replies nest.                  │
   │    └──────────────────────┘  sessions do NOT.        supersede_log
   │                                                      snapshots titles
   ├─ read_cursors   (workspace, peer, session)            so it outlives
   │                                                       what it describes
   └─ session_links  from_session_name ──> to_session_name
        relation + evidence_ref.  This is what getContext walks,
        bounded at MAX_LINKED_SESSIONS = 8.
```

---

## 3 · Three things the diagram cannot show

**`embedding` is `fixed_size_list<float32?>[384]`.** The dimension is frozen by
the Arrow column type, not by config. Changing the embedding model means a new
table version — hence the `_v1` suffix on `search_chunks_v1`, which is the only
table carrying one.

**Timestamps split by tier.** Tiers 1 and 2 use `timestamp[us]`. `traces` and
`mcp_calls` use `int64` for `created_at` / `updated_at`. That is inherited from
v3's trace format, not a design choice made here, and it means a query joining a
trace to a revision cannot compare the two time columns directly.

**There are no foreign keys.** LanceDB has none. Every "FK" above is a
convention enforced in application code — which is why `supersede_log` snapshots
`old_title` and `old_source` instead of pointing at a row that may be gone.
