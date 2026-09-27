# arra-oracle-v4 — Specification

**Version**: `v26.9.28-alpha.232`
**Status**: draft
**Date**: 2026-09-28 02:32 GMT+7
**Supersedes**: [`Soul-Brews-Studio/arra-oracle-v3`](https://github.com/Soul-Brews-Studio/arra-oracle-v3) (`26.7.26-alpha.227`)
**Repository**: <https://github.com/Soul-Brews-Studio/arra-oracle-v4>
**Author**: Neo (AI) with Nat — written by an Oracle, AI speaking as itself (Rule 6)

> **Versioning.** This spec and the implementation share one CalVer line:
> `v{yy}.{m}.{d}[-(alpha|beta).{HMM}]`, TZ `Asia/Bangkok`, where `HMM` is wall-clock as
> `H*100 + M` with no leading zero (07:00 → `700`). Each minute is a unique slot, so
> concurrent agents never collide on a version. Day-of-month may exceed 31 — it becomes
> a stable counter once the natural date is exhausted. Bump with `/calver --apply`;
> never combine a version bump with a code fix in one commit.
>
> Every material claim below carries a source. Measured claims cite the measurement;
> external claims cite a URL. See [§13 Provenance](#13-provenance).

---

## Current-status notice — historical specification retained

This document preserves the earlier research and SQL-oriented design; its storage/runtime/constraint statements are **not current implementation instructions**. Read [AGENTS.md](AGENTS.md) and [DESIGN.md](DESIGN.md) first. The active app uses Python LanceModel schemas, TypeScript/Bun/Elysia and canonical LanceDB, not libSQL metadata plus a Python-only vector index. Binary activity is chosen. The active registry is 15 tables / 152 fields; the 19-table revision design remains proposed. LanceDB does not supply SQL FK/uniqueness enforcement.

Sections 3.5, 4.1–4.7, 6.1, 9–10 and 15 contain superseded assumptions or unproved historical gates. Keep their measurements as dated evidence; do not treat them as authorization to reset data or reverse later decisions. SPEC's no-v3-migration rule still holds: DESIGN's copy-migration concerns the v4 spike only. Issue #23 owns remaining physical contract decisions; no timestamp/digest/revision-publication guarantee is frozen by this notice.

---

## 1. What this is

A memory server for Oracle agents. It stores typed documents, never deletes them,
isolates them into **banks**, and serves them to models over **MCP** — to Claude Code
with a bearer token, and to claude.ai with OAuth.

It is a **fresh implementation**, not a port. v3's proven ideas are inherited
deliberately and named below; v3's accumulated surface is not.

### 1.1 Why not just keep v3

v3 works, and its core decisions were right. What it also carries after a year:

| v3 today | v4 |
|---|---|
| 27 HTTP endpoints + 27 MCP tools | one small tool set (§6) |
| 5 vector backends (sqlite-vec, LanceDB, Qdrant, Chroma, Vectorize) | LanceDB only, behind the same adapter seam |
| 19-layer middleware pipeline | the layers that earn their place |
| Isolation axis called `tenant`, one level | `workspace` → `bank`, two levels (§3) |
| No OAuth — bearer/session only, local network | OAuth 2.1 for claude.ai (§7) |

### 1.2 Non-goals

- **Not** a psychological model of people. No peers, no representations, no
  theory-of-mind. (That is Honcho's job and Honcho does it better.)
- **Not** an opinionated reasoner. No disposition traits, no `reflect`. Retrieval
  returns documents; synthesis is the calling model's job.
- **Not** multi-writer-at-scale in v1. Single writer per bank (§4.7).
- **Not** a Cloudflare Worker. See §5.1 for why, and §5.4 for how Workers still fit.

---

## 2. Principles this encodes

1. **Nothing is Deleted** — supersede, never `DELETE`. Inherited from v3 and kept as a
   schema constraint, not a convention (§4.2).
2. **Small enough to understand** — if the tool surface takes more than 8 minutes to
   grok, it is too big.
3. **Local-first, cloud-ready** — every deployment difference is a config value, never
   a code fork (§5).
4. **Fail closed on isolation** — a bug must leak *nothing* rather than leak *quietly*
   (§3.4).

---

## 3. Data model

**v4's data model is Honcho's data model.** The core tables are byte-compatible with
[`plastic-labs/honcho`](https://github.com/plastic-labs/honcho) (`src/models.py`) — same
names, same columns, same constraints — so a bank exports to a running Honcho instance as
a plain table dump and imports back the same way. What arra-oracle-v3 knew that Honcho
does not (typed memories, supersede-not-delete, a controlled taxonomy) is added in
**separate tables Honcho never reads**. §15 states the contract.

> **Decision (2026-09-18, Nat):** *"go same Honcho, that's cool — but I need bank."*
> Honcho's schema, unchanged, with exactly one word renamed on the surface.

> **Measured (2026-09-27, #8; verdict accepted by Nat 2026-09-28):** "byte-compatible" is
> **false as stated**. A live INSERT of v4's tier-1 rows into stock Honcho v3.2.0 fails on the
> first column v4 names differently (`h_metadata`). What holds is **REST-level interchange** (proven live) and a **table-level
> import with conversions, for one bank into an empty Honcho**. §15.2 carries the measured
> terms; the paragraph above is the design intent it was measured against.

### 3.1 One alias — `bank`. Everything else keeps Honcho's word.

| Honcho table | v4 surface word | What it is |
|---|---|---|
| `workspaces` | **bank** ← *the only rename* | the tenant: isolation, auth, one LanceDB dataset |
| `sessions` | **session** | a room. Flat — no nesting |
| `peers` | **peer** | anyone who writes: oracle, human, agent, service |
| `messages` | **message** | one utterance in a session |
| `session_peers` | **session peer** | who is in which session, with join/leave history |

```
/mcp/:bank/:session    →    workspaces.name = :bank  ·  sessions.name = :session
```

That is the entire alias layer. **No table named `banks`, no column named `bank_id`.**
Wherever this document says *"the bank"*, the column is `workspace_name`. Everywhere else
the prose word and the column name are the same word — which is the point.

> **An earlier draft also surfaced `sessions` as "workspace". Withdrawn (Nat,
> 2026-09-18).** It put v4's word *workspace* onto Honcho's `sessions` while Honcho's own
> `workspaces` meant something else — one word naming two different tables across two
> systems that are meant to be interchangeable. **A session is a session.** The alias
> budget is one, and `bank` spends it.

```
bank ═══ workspaces ════════════════════════════════════════════════ tier 1, Honcho
│        the tenant · the isolation boundary · one LanceDB dataset
│
├── sessions ──────────── a room. Flat — no parent, no nesting (§3.1.1).
│     ├── session_peers ─ membership, with joined_at / left_at
│     └── messages ────── seq-ordered, peer-attributed, read-tracked
├── peers ─────────────── the address book. name = 'm5:arra-oracle-v3'
│
├── memories ──────────── typed · bitemporal · superseded-not-deleted ── tier 2, v4  §3.4
│     ├── chunk (LanceDB)  optional in v1                                            §4.4d
│     └── memory_terms ─── the tagging join                                          §3.3
├── vocabularies → terms  Drupal-shaped taxonomy                                     §3.3
├── supersede_log ─────── what changed, when, why — snapshotted                      §4.2
│
├── traces → trace_hits ─ what was searched, and what it found ──────── tier 3, v4   §14
├── mcp_calls ─────────── every tool call, ok and error alike                        §6.3
└── connections ───────── who is connected right now, folded on write               §7.2
```

#### 3.1.1 Flat — no nesting, anywhere

**A session has no parent.** There is no channel-versus-thread distinction, no
`parent_id`, no tree. A session is a room; if you want another room, you make another
session. That is the whole model.

An earlier draft borrowed a nested channel/thread shape. It is gone. Three reasons, in
increasing order of weight:

1. **Half the columns would be NULL** on any session that wasn't a thread — one table
   doing two jobs.
2. **Nothing bounded the recursion.** A self-referencing `parent_id` with no depth
   constraint admits nesting nobody designed for.
3. **Every listing query would need `WHERE parent_id IS NULL`, and forgetting it fails
   open** — the same disease as path-derived isolation (§3.5), somewhere new.

And the evidence: a survey of this fleet's vault (2026-09-18) found **8,598 messages
carrying `from` / `to` / `timestamp` / `read`, and no `thread_id`, no `in_reply_to`.**
Production conversation here is already entirely flat. Honcho is flat too — `sessions`
has no parent column.

> Replies still nest: `messages.in_reply_to` points at another message. **Threading is a
> property of messages, not of rooms.** That is the one place a tree is cheap and
> correct, and it needs no second table.

### 3.2 Tier 1 — Honcho's five tables, unchanged

Column names, types, uniqueness and foreign keys are Honcho's (`honcho/src/models.py`,
lines cited). v4 adds only **nullable** columns, marked `+v4`. Nothing Honcho wrote is
renamed, re-typed, or given a new meaning.

```
workspaces                                        surface: BANK            models.py:97
  id                 TEXT  PK · nanoid, len 21
  name               TEXT  UNIQUE        ← the FK target everywhere. Not `id`.
  created_at         TIMESTAMP
  h_metadata         JSON                ← user-visible
  internal_metadata  JSON
  configuration      JSON
  +v4 mission        TEXT NULL           ← descriptive only. Never behavioural.

peers                                             surface: peer            models.py:130
  id · name · workspace_name → workspaces.name
  h_metadata         JSON                ← kind · display_name · repo_url · mcp_url · last_seen_at
  internal_metadata · configuration · created_at
  UNIQUE (name, workspace_name)                                                    :156
      name = 'm5:arra-oracle-v3' — the WHOLE federation tag, host included.

sessions                                          surface: session         models.py:167
  id · name · workspace_name → workspaces.name
  is_active          BOOL default true   ← a boolean, not a status enum
  h_metadata         JSON                ← room · issue_url · issue_number · project
  internal_metadata · configuration · created_at
  UNIQUE (name, workspace_name)                                                    :195

session_peers                                     membership with history  models.py:569
  workspace_name · session_name · peer_name
  configuration · internal_metadata
  joined_at          TIMESTAMP
  left_at            TIMESTAMP NULL      ← leaving is a timestamp, not a DELETE
  FK (session_name, workspace_name) → sessions (name, workspace_name)
  FK (peer_name,    workspace_name) → peers    (name, workspace_name)

messages                                                                   models.py:206
  id                 INTEGER PK autoincrement   ⎫ two keys on purpose:
  public_id          TEXT nanoid, len 21        ⎭ internal order vs external handle
  workspace_name · session_name · peer_name     ← all three ON THE ROW
  content            TEXT ≤ 65 535
  token_count        INTEGER
  seq_in_session     INTEGER
  h_metadata · internal_metadata · created_at
  UNIQUE (workspace_name, session_name, seq_in_session)   :258  ← order is a CONSTRAINT
  FK (session_name, workspace_name) → sessions            :243
  FK (peer_name,    workspace_name) → peers               :248
  +v4 role           TEXT NULL     ← free text, NOT an enum — same rule as `type`
                                    (§3.4) and `mode` (§14.2). Seen: question,
                                    answer, note. A new one is a string, not a migration.
  +v4 in_reply_to    TEXT NULL     ← FK → messages.public_id. Replies nest; sessions don't.
  +v4 read           BOOL NULL     ← 8,597 vault files already carry these (§12.4)
  +v4 read_at        TIMESTAMP NULL
```

#### 3.2.1 Five things this gives you that v4 was about to reinvent worse

| # | Honcho does | v4 had drafted | Why Honcho's wins |
|---|---|---|---|
| 1 | **the tenant inside every foreign key** — `FK (session_name, workspace_name) → sessions (name, workspace_name)` | a tenant column + a runtime assertion | structural. You *cannot* reference a session in another bank; the database refuses. An assertion is discipline; a composite FK is physics |
| 2 | **names are keys** — every FK targets `workspaces.name`, never `id` | `id` + `slug` + `name` | one identifier. Readable rows, URLs, logs |
| 3 | `is_active: bool` | `status` enums on the room and the memory | two states need one bit, not a vocabulary |
| 4 | **ordering is a uniqueness constraint** — `UNIQUE(…, seq_in_session)` | order by `created_at` | timestamps tie under fast writes; a constraint cannot |
| 5 | **membership has history** — `session_peers.left_at` | nothing | Principle 1, in a join table |

#### 3.2.2 What v4 deliberately does not take

| Honcho has | v4 skips it because |
|---|---|
| `collections` + `documents` keyed on `observer` / `observed` (`:335`, `:379`) | theory-of-mind — *"what peer A believes about B"*. v4 has no `reflect`; copying it would be cargo cult |
| GIN `to_tsvector('english', content)` (`:264`) | English-only. **20.7% of this fleet's corpus is Thai.** Honcho's copy of the exact defect v4 exists to avoid. An FTS index is not data — v4 keeps `trigram` over the same column and the rows move either way |
| PostgreSQL | v4 is libSQL. Type mapping is mechanical, stated in §15.3 |

### 3.3 Taxonomy — vocabularies, terms, tagging

Adopted wholesale from [`digger-node`](https://github.com/Soul-Brews-Studio/digger-node),
which reached this design by reading how Drupal actually works. v4 does not re-derive
it.

**Four nouns Drupal got right in 2004:**

| Noun | Is |
|---|---|
| `memory` | one piece of content: title, body, datetime. **Honcho owns the word `document`** (§3.4), so v4 does not reuse it |
| `vocabulary` | a namespace for terms, **carrying a policy** (`kind`, below) |
| `term` | a label inside a vocabulary — nestable, ordered by weight |
| `memory_terms` | the join — a document wears any number of terms |

```ts
interface Vocabulary {
  id: string;
  workspace_name: string;          // FK → workspaces.name, NOT NULL — see "Scope".
                                   // The bank, in prose. Never a column named `bank_id`.
  name: string;             // machine name, lowercase slug, 1..64, unique per bank
  label: string;
  description: string;
  kind: 'tags' | 'categories';   // ← the whole point
  term_policy: 'open' | 'sealed'; // may a model call term_create here? (§6.2.2)
  created_at: string;       // ISO-8601 UTC
}

interface Term {
  id: string;
  vocabulary_id: string;    // FK → Vocabulary, ON DELETE CASCADE
  name: string;             // 1..128, UNIQUE per (vocabulary_id, name)
  description: string;
  parent_id: string | null; // FK → Term, ON DELETE SET NULL — terms nest
  weight: number;           // owner's chosen order, not an alphabetical accident
  created_at: string;
}

interface MemoryTerm {          // PRIMARY KEY (memory_id, term_id)
  memory_id: string;          // FK → Memory, ON DELETE CASCADE
  term_id: string;              // FK → Term,     ON DELETE CASCADE
}
```

#### 3.3.1 `kind` — the distinction that makes this worth copying

| `kind` | Behaviour | Shape |
|---|---|---|
| `'tags'` | **free-tagging** — unknown terms are created on demand | many, specific, flat, cutting across everything |
| `'categories'` | **controlled** — tagging with an unknown term **FAILS** | few, broad, hierarchical, stable |

> Free-tagging alone is the permissive default and **the wrong one for a store a model
> writes to**. An LLM tagging the same idea twice produces `mcp`, `MCP` and
> `model-context-protocol` — three rows, one concept, and a taxonomy that has quietly
> stopped being able to answer *"everything about X"*. Nothing errors. The corpus just
> rots.

The guard is a controlled vocabulary, and **the policy belongs to the namespace** —
which is exactly where Drupal puts it. This is the single most important line in §3.3.

#### 3.3.2 Hierarchy and weight

- `parent_id` because a flat tag list cannot express *"Bangkok is in Thailand"* without
  inventing a convention on top of the names.
- `weight` because a vocabulary should have the order its owner chose. This is the cheap
  half of Drupal's Taxonomy Menu module: a controlled vocabulary rendered in weight
  order **is** the menu, so there is no second system to keep in step.
- `UNIQUE (vocabulary_id, name)` — one term name per vocabulary. Two vocabularies may
  both hold `draft`.

#### 3.3.3 Scope — vocabularies belong to the **bank**

A term is a *label*, not content — but the label namespace still has to sit **inside** the
isolation boundary, not beside it. Since §3.1 makes **bank** the outer container,
`Vocabulary.workspace_name` is NOT NULL and every workspace in a bank shares one controlled
vocabulary. That is what makes *"everything about X across my rooms"* answerable without
opening a cross-bank seam.

> This closes a hole the inverted hierarchy had. When vocabularies were workspace-scoped
> and workspace sat *above* bank, two sibling banks could infer a term's existence from a
> vocabulary listing — a deliberate leak in an otherwise fail-closed design, carried in
> §10 as an open question. With bank as the outer container the leak cannot occur:
> **nothing at all crosses a bank boundary, including labels.**

#### 3.3.4 Refusals must name the caller's mistake

A controlled-vocabulary violation is a **routine, expected** outcome — it is the guard
working, not a crash. The message must be actionable by a model:

```
✅  "Enginering" is not a term in the controlled vocabulary "status".
    Available: draft, published, review.

❌  D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT
```

The second describes the storage engine's difficulty rather than the caller's mistake,
and no model can act on it. Likewise `tag id="doc_nope"` → `no document with id
doc_nope`.

#### 3.3.5 Who tags: the model, not the person

The division of labour is the design. A person writes and files nothing; the model
reads and classifies.

- the human-facing create path has **no tag field**
- every term in a UI sidebar is a **filter you click**
- anything nobody has classified collects in **`untagged`** — which is not a warning,
  it is **the agent's work list**

`list_documents(untagged: true)` is therefore a first-class query, not an afterthought.

### 3.4 Tier 2 — the memory layer, from arra-oracle-v3

What v3 knew that Honcho does not: a typed, superseded-not-deleted, bitemporal knowledge
store with a controlled taxonomy over it. It hangs off the bank, and optionally off a
session, with the same composite-FK discipline as tier 1.

> **The table is `memories`, not `documents`.** Honcho already owns `documents`
> (`models.py:379`) with a different meaning. A v4 table with the same name and a
> different shape would look compatible and not be — the one kind of incompatibility that
> actually hurts.

**Tier 2 is written in tier 1's idiom.** Honcho's five tables share one shape —
`id` + `name` + `workspace_name`, a pair of JSON bags (`h_metadata` user-visible,
`internal_metadata` internal), `created_at`, `UNIQUE(name, workspace_name)`, and composite
FKs that carry the tenant. v4's own tables use **the same shape**, which is what keeps the
schema one thing to learn instead of two (§3.4.1).

```
memories                                                         tier 2 · v4 only
  id                 TEXT PK · nanoid(21)
  name               TEXT            ← slug. UNIQUE (name, workspace_name), Honcho's idiom
  workspace_name     TEXT NOT NULL  FK → workspaces.name    ← THE isolation constraint
  session_name       TEXT NULL                              ← filed in a session. Organisation, not scope.
  peer_name          TEXT NULL                              ← who WROTE it. Attribution, Honcho's idiom
  subject_peer_name  TEXT NULL                              ← who it is ABOUT. §3.4.2
  FK (session_name,      workspace_name) → sessions         ← composite: cannot file into another bank's session
  FK (peer_name,         workspace_name) → peers            ← composite, same reason
  FK (subject_peer_name, workspace_name) → peers            ← composite, same reason
  type               TEXT default 'note'  ← free text, guarded by a vocabulary named `type` (§3.3)
  content            TEXT
  created_at         TIMESTAMP            ← when we LEARNED it   ⎫ bitemporal
  valid_from         TIMESTAMP NULL       ← when it STARTED being true   ⎬ an interval,
  valid_to           TIMESTAMP NULL       ← NULL = still true            ⎭ not a point §3.4.2
  sync_state         TEXT pending|synced|failed   ⎫ Honcho's three columns, on the row
  last_sync_at       TIMESTAMP NULL                ⎬ (models.py:411–417) — not a
  sync_attempts      INTEGER default 0             ⎭ reconciler table (§4.6.1)
  superseded_by      TEXT NULL FK → memories.id   ← pointer; the reason lives in supersede_log
  superseded_at      TIMESTAMP NULL
  is_active          BOOL default true            ← publish flag, Honcho's idiom.
                                                    Unpublish is reversible; supersede is deliberate.
  h_metadata         JSON   ← title · source_file · project · origin · line_start · line_end
  internal_metadata  JSON

vocabularies   id · name · workspace_name NOT NULL · label · description
               kind: tags | categories · term_policy: open | sealed
               h_metadata · internal_metadata · created_at
               UNIQUE (name, workspace_name)                                    §3.3
terms          id · vocabulary_id · name · description · parent_id · weight
               h_metadata · created_at · UNIQUE (vocabulary_id, name)
memory_terms   PK (memory_id, term_id) · both CASCADE
supersede_log  id autoincrement · workspace_name NOT NULL
               old_id · old_title · old_type · old_source   ← snapshotted at supersede time
               new_id NULL (= retired) · new_title · new_source
               reason · peer_name → peers · superseded_at · h_metadata           §4.2
```

#### 3.4.1 What this shape costs, and what it bought

Two columns left tier 2 in the Honcho-idiom pass, and both were carrying a duplicate:

| Cut | Why |
|---|---|
| `memories.chunk_index` | chunking is a **LanceDB** concern — `chunks.chunk_index` (§4.5) is already the per-chunk ordinal, one row per chunk. A single `chunk_index` on the parent memory names no particular chunk and conflates two granularities |
| `memories.superseded_reason` | `supersede_log.reason` (§4.2) already holds it, **snapshotted at supersede time**. Two writable copies of one sentence, and the log's copy is the one that survives later edits |

Six display-and-provenance fields — `title`, `source_file`, `project`, `origin`,
`line_start`, `line_end` — moved into `h_metadata`. **The test applied was: is it a filter
key or a display field?** Everything callers filter or join on stays a real column, because
Lance and libSQL both push predicates down on columns and neither does on JSON. Everything
rendered but never queried goes in the bag, exactly as Honcho puts `display_name` and
`repo_url` there rather than growing `peers` to eleven columns.

Columns arrived too. **`peer_name`**: tier 2 previously had no author at all —
`supersede_log` recorded who *retired* a memory while nothing recorded who *wrote* it.
Honcho attributes every message to a peer; adopting its shape closed a gap v4 had not
noticed. **`subject_peer_name`** and the **`valid_from`/`valid_to`** pair are §3.4.2.

#### 3.4.2 Life, events and chat — three shapes, no new tables

Three things a memory bank is asked for, and where each already lives:

| Asked for | Table | New machinery |
|---|---|---|
| **chat log** | `messages` (tier 1) | **none.** Seq-ordered, peer-attributed, per session per bank. 8,598 vault files are already this shape (§14.7) |
| **event** | `memories`, `type='event'` | the valid interval, below |
| **life** | `memories`, `type='life'`, `subject_peer_name` set | the interval **and** the subject |

**`life`, `event`, `chat`, `note`, `decision` are terms, not tables.** They are rows in the
`type` vocabulary (§3.3), and because that vocabulary is `kind: 'categories'`, an unknown
type **fails closed** rather than quietly minting a sixth spelling of one concept. Adding a
kind of memory is a term insert. It is never a migration.

**Why an interval and not a point.** `valid_time` was a single timestamp, inherited from
v3's `oracle_documents`. v3's *other* memory table, `oracle_memories`, carried
`valid_from`/`valid_to` — a real interval — and for life facts that is the one that works:
*"lived in Chiang Mai 2015–2020"* and *"what was true in March 2026"* are both unaskable
against a point. v4 takes the better of v3's two models. `valid_to IS NULL` means still
true, so the current-state query is

```sql
WHERE valid_from <= :t AND (valid_to IS NULL OR valid_to > :t)
```

and `created_at` stays what it always was — when *we learned it*, which is a different
question from when it was *true*, and the reason this is called bitemporal.

**Why `subject_peer_name` is not Honcho's observer/observed.** §3.2.2 skips Honcho's
`collections`/`documents` (`models.py:335,379`) because they model *theory of mind* —
what peer A **believes about** peer B — and v4 has no `reflect`. The subject axis is
separable from that and much cheaper: a memory *about* Nat is a fact the bank holds, not a
belief one peer holds about another. That needs **one nullable column**, not two tables and
an observer dimension. If v4 ever grows real theory-of-mind, Honcho's tables are still
there to adopt whole — this column does not block that and does not pretend to be it.

**Scope answers both readings of "per workspace."** `workspace_name NOT NULL` scopes every
memory to the bank; `session_name` optionally narrows it to one room. So *"Nat's life
events in this bank"* and *"what happened in this room"* are both plain indexed queries,
and neither can cross a bank boundary (§3.5).

**A timeline across all three is a view, not a table** — `UNION` of `messages` by
`created_at` and `memories` by `valid_from`. Two ordered reads, no third copy of the data.

Tier 3 — `traces`, `trace_hits`, and the observability tables (`connections`,
`mcp_calls`) — is in §14, §7.2 and §6.3, in the same idiom and under the same rule:
`workspace_name NOT NULL` on every row, composite FKs to any session or peer it references.

### 3.5 Isolation — fail closed, by schema

v3 isolates vectors by **filesystem path** (`tenantDataPath()` folded into the LanceDB
directory, the adapter itself tenant-blind). Elegant, cheap, and it **fails open**: one
code path that builds a path without the helper silently shares a dataset, and nothing
errors. v3's two live isolation holes (`forum_messages`, `supersede_log` — no tenant
column at all) are the same failure: the tenant was a *convention*, not a *constraint*.

v4 takes Honcho's answer, which is structural, and keeps two backstops:

| Layer | Mechanism | Failure mode |
|---|---|---|
| **Schema** | `workspace_name NOT NULL` on every row · **composite FKs** carry it into every reference | **cannot fail** — a cross-bank reference is a constraint violation at INSERT |
| Storage | one LanceDB dataset per bank, path derived from `workspaces.name` | fails open |
| Vector rows | `workspace_name` stored **in the Lance schema**, asserted on every read | fails closed |
| Access | `resolveBank(name)` is the **only** way to get a handle | single choke point |

The composite FK is the load-bearing row. It is why §11's criterion — *"two banks provably
cannot see each other's memories"* — is enforced by the database rather than proven by a
test. The test still exists; it now documents a guarantee instead of supplying one.

`workspace_name` in the vector rows stays intentional duplication: LanceDB has no foreign
keys, so the schema guarantee stops at the libSQL boundary and the assertion carries it across.

---

## 4. Storage

### 4.1 Two stores, one owner

| Store | Holds | Engine |
|---|---|---|
| Metadata + FTS | workspaces, banks, documents, supersede chain, entity links, **full-text index** | **Turso / libSQL** |
| Vectors + chunks | embedded chunks, `workspace_name`, doc pointer | **LanceDB** — **optional in v1**, behind the §4.3 driver seam (§4.4d) |

**Turso (libSQL), not stock SQLite.** libSQL is SQLite-compatible, so Drizzle and the
whole SQLite mental model carry over, and it offers **embedded replicas** as an opt-in
path to cloud.

> ⚠️ **Correction (2026-09-18).** An earlier draft claimed embedded replicas "give the
> local-first → cloud seam directly". **That is wrong.** Per Turso's documentation:
> *"Writes are sent to the remote primary database configured at `syncUrl` by default.
> They are NOT written to the local file first."* Write transactions containing reads
> always go to the primary. So with a sync URL configured and the network down,
> `remember` **fails**.

**The rule v4 adopts: the local file is the source of truth. Sync is replication you
opt into.**

| Mode | Config | Writes offline |
|---|---|---|
| **Local-only** (default) | `ORACLE_DB_URL=file:...`, no sync URL | ✅ always — a plain local libSQL file |
| Replica, online | `+ ORACLE_DB_SYNC_URL` | ✅ forwarded to primary |
| Replica, offline | `+ ORACLE_DB_SYNC_URL` | ❌ **fails** unless `offline: true` is set |

If a deployment both syncs *and* must survive a network outage, `offline: true` is
mandatory, not optional. Local-first and replicated-by-default are **not** the same
posture, and v4 defaults to the first.

#### 4.1.1 Why FTS lives in libSQL and vectors do not

libSQL *can* store vectors natively (`F32_BLOB` + `libsql_vector_idx`, DiskANN). v4
still keeps vectors in LanceDB, for measured reasons — see §4.4.

#### 4.1.2 FTS tokenizer — character trigrams, non-negotiable

**On LanceDB the tokenizer is spelled `ngram`, with `ngramMinLength: 3` and
`ngramMaxLength: 3`.** Never `simple`, and never the omitted default.

> ⚠️ **Correction (2026-09-22), measured against the installed SDK.** This section
> previously read `tokenize='trigram'. **Never `unicode61`.**` — SQLite FTS5 syntax.
> **`@lancedb/lancedb` 0.38.0 refuses both of those strings:**
>
> ```
> Index.fts({ baseTokenizer: "trigram" })    -> Invalid input, unknown base tokenizer trigram
> Index.fts({ baseTokenizer: "unicode61" })  -> Invalid input, unknown base tokenizer unicode61
> ```
>
> A bogus name (`definitely-not-a-tokenizer`) is rejected with the identical message,
> which proves the name is genuinely validated rather than silently ignored. So this
> spec mandated an **unbuildable configuration**, and #10 was blocked on a vocabulary
> mismatch rather than on a technical disagreement.
>
> The *capability* is intact and is the shipped default of `ngram`: the engine's own
> `listIndices()[0].indexDetails` reports `min_ngram_length: 3, max_ngram_length: 3,
> prefix_only: false` for a bare `Index.fts({ baseTokenizer: "ngram" })`. Corroborated
> independently — over the same 200 rows, `ngram` default and explicit `ngram(3,3)`
> produced **byte-identical index artifacts** (66,668 B across 10 files), while
> `ngram(2,4)` gave 51,953 and `icu` 46,676.
>
> Full accepted set at 0.38.0: `icu`, `icu/split`, `simple`, `whitespace`, `raw`,
> `ngram`. **Omitting `baseTokenizer` resolves to `simple`, not `icu`.** `jieba/*` and
> `lindera/*` are known names gated on language-model data that is not installed —
> NOT RUN, not unsupported.

Thai combining marks are token *breaks* under a word-boundary tokenizer, so Thai is
invisible from the inside of a word. Measured on this fleet's corpus with SQLite FTS5,
`ความ` returned **5 hits under `unicode61` where trigram returned 435**.

> ⚠️ **That 435-vs-5 number is retained as history, not as LanceDB evidence.** It
> necessarily came from SQLite FTS5, since LanceDB accepts neither tokenizer named in
> it, and its corpus was not available for re-measurement — **NOT RUN**, neither
> confirmed nor contradicted.
>
> **`ความ` is the wrong query to test this with.** Measured 2026-09-22 on LanceDB
> 0.38.0: `icu` **finds** `ความ`, because `ความ` sits at offset 0 of its row and is a
> complete ICU token, as is `ทรงจำ` (ICU splits the row `ความ|ทรง|จำ`). ICU is not
> blind to Thai — it is blind only to **sub-segment** queries. Anyone re-running this
> section's own example against LanceDB `icu` will see a hit and wrongly conclude ICU
> is sufficient.
>
> **The discriminating query is `ลืม` inside the stored word `หลงลืม`** — the
> counterexample #10 already carried:
>
> | Tokenizer | `ลืม` inside `หลงลืม` | `หลงลืม` whole | `ความ` | `brown` (ASCII) |
> |---|---|---|---|---|
> | `icu` | **miss** | hit | hit | hit |
> | `icu/split` | **miss** | hit | hit | hit |
> | `simple` / `whitespace` / *(unset)* | miss | miss | miss | hit |
> | `raw` (not-a-tokenizer control) | miss | miss | miss | **miss** |
> | `ngram` / `ngram(3,3)` / `ngram(2,4)` | **hit** | hit | hit | hit |
>
> `ลืม` *is* a literal substring of the stored `หลงลืม` and `icu` returns **zero** — a
> substring scan cannot produce that number, and FTS with no index *errors*
> (`Cannot perform full text search unless an INVERTED index has been created`), so a
> silent scan fallback is impossible. Measured inside-word Thai recall for `icu` on
> these fixtures: **0/2** (`ลืม`, and `หลง` inside `หลงลืม`).
>
> Fixtures were agent-authored (4 and 5 rows) with no relevance judgments — this
> establishes *which tokenizer can do the job*, not *which retrieves better*. That
> remains #7, and #7 stays open.

**The working call shape**, proven end to end rather than read off documentation:

```ts
await tbl.createIndex("content", {
  config: Index.fts({
    baseTokenizer: "ngram",   // "trigram" -> Error: unknown base tokenizer trigram
    ngramMinLength: 3,
    ngramMaxLength: 3,
    prefixOnly: false,
    stem: false,              // DEFAULT IS true  -- must be turned off
    removeStopWords: false,   // DEFAULT IS true  -- must be turned off
  }),
  replace: true,
});
```

`stem: false` and `removeStopWords: false` are **mandatory, not stylistic**. Both
default to `true`, and stop-word removal runs *even in ngram mode*: the query `the`
returns `[]` under `ngram` defaults and hits under `stem:false, removeStopWords:false`.
An ngram index built without disabling both is not a faithful trigram index. Verify
with `listIndices()[0].indexDetails`, not by trusting the call site.

> **arra-oracle-v3 shipped `unicode61`-only and is structurally unable to find Thai
> inside words.** This is a known inherited defect that v4 exists to not repeat.
> Verified 2026-09-18: `arra-oracle-v3/src/db/migrations/0017_fts5_bootstrap.sql` uses
> `porter unicode61`, as does `indexer-pro/src/db/index.ts`. Of the fleet's five markdown
> indexers only **`digger-node`** (`migrations/0001_init.sql:125`) and **`session-viewer`**
> (`schema.sql:115`, a second `events_fts_tri` table) use `trigram` — and `session-viewer`
> is the only one that *routes by query length* between a `unicode61` and a `trigram`
> index. **20.7% of this fleet's vault contains Thai** (2,088 of 10,073 files), so the
> three `unicode61` indexers cannot see a fifth of the corpus from the inside of a word.

Costs of trigram, accepted knowingly: ~1.8–3× index size, cannot match a needle under 3
characters (fall back to `LIKE` **and say so in the response**), and must never be
handed a wildcard. Measured 2026-09-22: below-minimum queries **die silently** — 1-char
`ล` and 2-char `ลื` both return `[]`, 3-char `ลืม` returns the row, confirming
`min_ngram_length: 3` directly rather than by inference. Over-match is real in both
scripts: `row` matches "brown", and `งลื` — a meaningless fragment spanning a word
boundary in `หลงลืม` — matches, where `icu` returns nothing for both. Index size was
1.43× on a 200-row fixture, too small to test the 1.8–3× claim; that remains unmeasured
at scale, and higher recall with unmeasured precision is not "better". Every FTS token is quoted on the way in — an unquoted hyphen parses
as FTS5's `NOT` and returns silence.

> This finding has now been independently measured **four times** across this fleet. It
> is the single most re-derived result we have, which is why it ships as a hard default
> rather than being rediscovered a fifth time.

> ⚠️ **Correction (2026-09-18).** An earlier draft let this read as a reason FTS must
> live in libSQL. It is not. **LanceDB also has an n-gram tokenizer** — verified in
> `@lancedb/lancedb@0.27.2`: `baseTokenizer?: "simple" | "whitespace" | "raw" | "ngram"`
> (`dist/indices.d.ts:479`) with `ngramMinLength` / `ngramMaxLength` (`:509`, `:513`)
> and `prefixOnly` (`:515`). `min=3, max=3` is trigram.
>
> **Resolved (2026-09-18, independent verification).** Lance's n-gram is
> **character-level over the whole text**, so `ความ` trigrams exactly as FTS5 trigram
> does: tantivy `NgramTokenizer::new(min, max, prefix_only)` at
> `lance-index-11.0.0/src/scalar/inverted/tokenizer.rs:1095–1103`. An `icu` tokenizer
> (real Thai word segmentation) also exists at `:1091`. **This fleet has already shipped
> it** — `ψ/lab/01-arra-memory-lancedb` is a complete LanceDB-only port of
> arra-memory-haos using `ngram(3,3)` (`arra-memory/src/db.ts:319–321`), measuring FTS
> `"ความจำ"` at 5 ms @3k rows and 22 ms @30k.
>
> Thai therefore does **not** decide the engine. Three Lance-side traps do remain, all
> found by that lab's adversarial audit and each now carrying a regression test:
>
> | Trap | Detail |
> |---|---|
> | `MatchQuery` defaults to **OR** (`dist/query.d.ts:504`) | FTS5 trigram `MATCH` means *contiguous substring*; Lance ORs the trigrams and ranks by BM25, so rows merely sharing trigrams compete for slots. The lab saw "three rows at limit 100 and nothing at limit 30" until it pushed `LIKE` into `WHERE` for membership and used the index only for ranking. `operator: And` gives all-trigrams-present, not contiguity; `PhraseQuery` gives contiguity at index-size cost |
> | `removeStopWords: true`, `stem: true` are **defaults** | both silently mangle trigrams |
> | **The FTS index does not follow writes** | new rows are served by a flat BM25 pass over the unindexed tail (`lance-11.0.0/src/io/exec/fts.rs:1550–1552`) until `optimize()`; `fastSearch()` skips them entirely (`dist/query.d.ts:204–210`). The lab runs `optimize()` every 10 minutes |
>
> The doc comment above the union (`:471–478`) still documents only
> `simple | whitespace | raw` — `ngram` remains undocumented API surface.
>
> The honest statement: **trigram is non-negotiable; which engine provides it is not
> decided by Thai.** The reasons libSQL holds FTS are the relational ones in §4.4d.

#### 4.1.3 External-content FTS needs its triggers or it lies

The FTS table is `content='documents'` (external-content) so the text is not stored
twice. External-content FTS5 **does not follow its source table on its own**. Without
all three triggers — `AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE` — the index drifts
silently, which is worse than having no index: searches then return confidently wrong
results.

The `DELETE` and `UPDATE` triggers must emit FTS5 `'delete'` rows for the *old* values.
A bare `UPDATE` leaves the previous text matchable forever.

### 4.2 Supersede — a pointer *and* a log

There is no `DELETE` in the write path. Supersede is how a memory stops being current.

It is recorded in **two places, deliberately**, following v3 (`oracle_documents`
columns + a separate `supersede_log` table):

**1. The pointer, on the document** — answers *"is this current, and what replaced it?"*

```ts
superseded_by: string | null;      // → the memory that replaced it
superseded_at: number | null;
```

Default queries filter `superseded_by IS NULL`. History is always reachable with an
explicit flag — never by a different table.

**The reason is not here.** It lives once, in `supersede_log.reason` below, snapshotted at
supersede time. An earlier draft carried `superseded_reason` on the row as well; that is
two writable copies of one sentence, and the log's copy is the one that survives a later
edit to the row it describes (§3.4.1).

**2. The log, standalone** — answers *"what changed, when, and why?"*

```ts
interface SupersedeEntry {
  id: number;                  // autoincrement — the log is ordered
  workspace_name: string;             // NOT NULL — the log is bank-isolated too (§3.4)

  old_id: string;              // the superseded document
  old_title: string | null;    // ← snapshotted at supersede time
  old_type: string | null;     // ←
  old_source: string | null;   // ←

  new_id: string | null;       // null = retired with no replacement
  new_title: string | null;
  new_source: string | null;

  reason: string | null;       // the ONLY copy — see the pointer block above
  peer_name: string | null;    // FK (peer_name, workspace_name) → peers (§3.2) when
                               // known, else a label. Honcho's word, one fleet (§3.4.1).
  superseded_at: number;
  h_metadata: object;          // project, and whatever else the caller attached
}
```

#### 4.2.1 Why both — the log is not redundant

Three things the pointer alone cannot do:

| Question | Pointer | Log |
|---|---|---|
| "Is this doc current?" | ✅ one column read | ✗ would need a scan |
| "What changed in this bank last week?" | ✗ no time-ordered view | ✅ indexed on `superseded_at` |
| "What did this doc say *before* the title was rewritten?" | ✗ reads the live row, already changed | ✅ `old_title`/`old_type` snapshotted |
| "Retired with nothing replacing it" | ✗ `superseded_by` is null — indistinguishable from *current* | ✅ an explicit row with `new_id = null` |

That last row is the sharp one. **A pointer cannot express "retired, replaced by
nothing"** — `superseded_by IS NULL` already means *current*. Without the log,
withdrawing a wrong memory is either impossible or requires a sentinel value. The log
makes it an ordinary entry.

#### 4.2.2 The snapshot columns are the point

`old_title` / `old_type` / `old_source` are copied **at supersede time**, not joined at
read time. A join would show whatever the row says *now* — and the row may itself have
been edited since. The log is a record of a decision as it was made, so it carries its
own evidence.

This is the same reasoning as `connections.label` being "resolved at write time" (§7.2),
and the opposite of `status` in Lance (§4.5.4), which is deliberately derived. Snapshot
what a *decision* saw; derive what merely *reflects* current state.

#### 4.2.3 Supersede is append-only and never rewritten

Superseding a document that is *already* superseded appends a second entry — it does
not edit the first. The chain `A → B → C` is three documents and two log rows, and all
of it stays readable.

`supersede_chain(doc_id)` walks it in either direction. This is the one query that
makes Principle 1 useful rather than merely true: *nothing is deleted* is worth little
if the history cannot be traversed.

#### 4.2.4 Everything else that "deletes" is also a status change

| Thing | Retirement mechanism |
|---|---|
| Memory | `superseded_by` + log entry (above) |
| Bank | `status`, never a drop |
| Vocabulary | `status` — **not** `vocabulary_delete` (corrects §6.2.2) |
| Term | superseded by another term via `term_merge`, not deleted |
| Credential | **hard delete** — named exception (§7.3) |
| Call log row | **expires** — named exception, telemetry not memory (§6.3) |

Physical removal of any of the first four is an out-of-band operator action, never an
API call, and it is the only path that needs the purge runbook.

> The two exceptions are deliberate and both concern things that are **not memory**: a
> revoked secret must stop existing, and telemetry must not grow without bound.

### 4.3 Storage drivers — the local/cloud seam

One interface, two drivers, selected by config. **No code path branches on
deployment.**

```
# metadata + FTS — one engine, sync is a config value
ORACLE_DB_URL=file:./data/meta.db                    # local only
ORACLE_DB_URL=file:./data/meta.db  ORACLE_DB_SYNC_URL=libsql://...  ORACLE_DB_TOKEN=...
                                                     # embedded replica: local reads, cloud sync

# vectors
ORACLE_STORAGE=local   ORACLE_DATA_DIR=./data
  → LanceDB at   ./data/<workspace>/<bank>/

ORACLE_STORAGE=s3      ORACLE_S3_BUCKET=... ORACLE_S3_ENDPOINT=...
  → LanceDB at   s3://<bucket>/<workspace>/<bank>/
```

Note the asymmetry: metadata needs no `local | cloud` switch at all, because an
embedded replica *is* a local file. Only the vector store has two drivers.

**Cloudflare R2 is the intended `s3` target.** LanceDB addresses object stores as
`s3://bucket/path` with `storage_options` for `endpoint`, `region`, `allow_http`, and
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, and documents support for S3-compatible
stores (MinIO, Tigris named explicitly). R2 exposes an S3 API with exactly those
knobs.

> ⚠️ **Unverified.** LanceDB does not name R2 in its docs. This is a design assumption
> requiring a spike before it is load-bearing — see §9-S1.

### 4.4 Why vectors live in LanceDB, and why FTS is the default

libSQL can index vectors natively (`F32_BLOB` + `libsql_vector_idx`, DiskANN), so a
one-store design is technically available. v4 does not take it, for two measured
reasons from this fleet.

**(a) Retrieval quality — FTS wins on this corpus shape.** Measured on 124,049 real
session blocks (n=200, k=20), known-item retrieval MRR:

| Method | MRR |
|---|---|
| **FTS** | **0.765** |
| bge-m3 vectors | 0.099 |
| MiniLM vectors | 0.063 |
| hybrid RRF | 0.437 — **worse than FTS alone** |

RRF weights both lists equally, so a confident-but-wrong vector list drags the correct
lexical list down. Vector/FTS top-10 Jaccard overlap is 0.009–0.018.

> **Design consequence.** `recall` is **keyword/trigram first**. Semantic search is a
> **separate explicit mode**, not a blended default. Near-zero overlap is the argument
> for keeping both — as alternatives, not as a fused ranking. Do not ship RRF-by-default
> on the strength of it being conventional; four fleet systems independently converged
> on RRF k=60 *against* this measurement.

**(b) Operational blast radius — keep DiskANN out of the metadata file.** In
`ψ/lab/turso-agents-index`, `agents.db` reached **92 GB while holding 4.2 GB of live
data** — 23.1M of 24.2M pages (95%) were freelist. Cause: `DROP INDEX` +
`CREATE INDEX ... libsql_vector_idx(embedding)` on every run, each drop freeing a whole
DiskANN shadow tree over 442k × 1024-d vectors. SQLite never returns freelist pages to
the OS, `auto_vacuum` was off, and a watch daemon rebuilt ANN daily.

Putting vectors in LanceDB keeps that failure mode out of the file that holds
workspaces, banks, and the supersede chain.

> ⚠️ **Correction (2026-09-18).** This reason is **weaker than written above.** The
> 92 GB file was produced by an **ops pattern** — a watch daemon running
> `DROP INDEX` + `CREATE INDEX ... libsql_vector_idx` nightly over 442k×1024-d vectors
> — **not** by an engine property of storing vectors in SQLite. A design that never
> drops and rebuilds an ANN index on a schedule does not reproduce it.
>
> At v1 scale the index is not needed at all: 10k chunks × 1024-d float32 is a ~40 MB
> brute-force scan, tens of milliseconds, and v3 runs 7,130 documents with **zero**
> embeddings. **Rule if vectors ever land in libSQL: build `libsql_vector_idx` only past
> a threshold (~50k chunks), never drop it, and re-embed into a new column or table.**
> The four mandatory operational rules at the end of §4.4c already say the rest.
>
> Consequence: §4.4's *two* stated reasons for a second store are now both qualified —
> (a) measures a corpus shape that is not v4's (see §9-S8), and (b) blames an engine for
> a schedule. §4.4d is the resulting decision.

#### 4.4c LanceDB has its own growth pathology — it is not the safe side

The previous two points explain why vectors stay out of libSQL. They must not be read
as "LanceDB is free of this problem". It has a different one, and the spec owes it the
same page:

- **Every `remember` is a Lance commit** — one fragment plus one manifest version. On
  R2 that is N more objects, per write.
- **Scan cost grows with fragment count.** Many tiny fragments is the pathological shape,
  and single-row appends produce exactly that.
- **`optimize()` / compaction is required**, not optional, and it is a scheduled
  operation nobody will run unless the spec says to.
- **`cleanup_old_versions()` deletes old manifest versions** — a *hard delete*, which
  must be squared with Principle 1 (§2.1). Resolution: Lance version history is
  **storage-engine bookkeeping, not the memory record**. The memory record's history is
  the supersede chain in libSQL (§4.2), which is never touched by compaction. Say this
  out loud so nobody "protects" old Lance versions in the belief they are the archive.
- **No ANN index policy is specced**, so a query on R2 brute-forces the dataset over
  HTTP. An index-build threshold is needed.

Expected to bite around 10k memories on R2 — see spike **S7**. Until S7 closes, treat
per-write commit cost as unmeasured.

**If v4 ever does put vectors in libSQL**, these are mandatory, not optional:
- check `PRAGMA freelist_count` against `page_count` before believing a file is "too big"
- set `auto_vacuum=INCREMENTAL` *before* the first full VACUUM
- VACUUM **through `@libsql/client`**, never the stock `sqlite3` CLI — VACUUM replays the
  schema and stock SQLite dies with `no such function: libsql_vector_idx`
- never `DROP`+`CREATE` an ANN index on a schedule

#### 4.4d Could LanceDB be the *only* store? No — and the real question is the inverse

Asked directly (Nat, 2026-09-18). Answered against `@lancedb/lancedb@0.27.2` type
definitions, not from memory.

**LanceDB-only is not viable.** Five load-bearing guarantees in this spec have no
LanceDB equivalent:

| # | Guarantee | Spec | Why Lance cannot |
|---|---|---|---|
| 1 | `memory_terms` many-to-many resolution | §3.3 | **No joins.** `join`, `groupBy`, `aggregate` return zero hits in `dist/query.d.ts`. Every tag query becomes a scan plus a client-side merge |
| 2 | Fail-closed isolation | §3.4 | No `NOT NULL`, no foreign keys. The `workspace_name` FK that §3.4 calls "fails closed" degrades to an application check — which is the layer §3.4 exists to stop relying on |
| 3 | Controlled vocabulary **refuses** an unknown term | §3.3.1 | No `UNIQUE (vocabulary_id, name)`, no FK. The guard becomes a read-then-write race, so the corpus rot §3.3.1 describes returns |
| 4 | `supersede_log` is ordered | §4.2 | No autoincrement |
| 5 | Threads, messages, entities | §12 | `peer_name` FK, `in_reply_to` self-reference, thread→message cascade — relational throughout |
| 6 | Multi-table atomicity | §3.3, §4.2 | `tag` must check `kind` + term existence + insert the join as one act; `supersede` must UPDATE the pointer and INSERT the log together. Lance commits **one table at a time** |
| 7 | `connections` folded on write | §7.2 | `requests++` on **every HTTP request** → one fragment + one manifest **per request**. No compaction schedule survives this. Same for `mcp_calls` (§6.3), one commit per tool call |
| 8 | Concurrent `term_create` | §3.3.1 | `mergeInsert` is **not** an upsert under concurrency — two writers read the same table version, both find no match, both insert. The lab had to serialise per key in-process to recover what a PRIMARY KEY gives free. This is exactly the `mcp` / `MCP` duplication §3.3.1 exists to prevent |

Per-row mutation does exist (`update({where, values})`, `dist/table.d.ts:117/131/161`;
`delete(predicate)`, `:169`), so supersede is *expressible* — but the cost is larger than
§4.4c implies. `lance-11.0.0/src/dataset/write/update.rs:440–506`: an UPDATE writes the
updated rows as **new fragments**, applies **deletion vectors** to the old fragments, then
commits a **manifest** — and the new row is unindexed, for vectors *and* FTS, until
`optimize()` runs. **10k supersedes without compaction ≈ 10k tiny fragments + 10k deletion
files + 10k manifest versions.** §4.4c framed this as an *append* pathology driven by
`remember`; it is equally driven by `supersede` and by the `sync_state` update in §4.6.

**The inverse question is the live one.** Nothing in §3, §4.2, §6, §7 or §12 needs
LanceDB. Set against that:

- FTS scores **0.765** to vectors' **0.099** on this corpus shape (§4.4a)
- hybrid RRF scores **0.437** — worse than FTS alone (§4.4a)
- **arra-oracle-v3 runs 7,130 documents with 0 embeddings in production.** The vector
  subsystem is fully present and has never been switched on
- LanceDB adds native Rust bindings that **cannot run in a Worker** (§5.1), a mandatory
  compaction obligation (§4.4c), an immutable vector dimension (§4.5.3), and the entire
  two-store consistency seam (§4.5.4, §4.6)

**Decision: libSQL is mandatory; LanceDB is optional in v1, behind the §4.3 driver
seam.** v1 ships keyword/trigram recall — which §4.4a already makes the default — and
semantic recall reports *"not enabled"* rather than silently returning nothing. Adding
LanceDB later is a driver, not a migration, because §4.3 already defines that seam.

This is deliberately the **reversible** direction. Shipping both stores first and
removing one later is a rewrite; shipping one and adding the second is config.

**The viable LanceDB-only subset, for the record:** one `memories` table with
`tags: List<Utf8>`, no vocabulary/term tables, no threads, one process, one writer.
That is precisely what `ψ/lab/01-arra-memory-lancedb` built and audited (44 agents,
9 defects fixed) — so the boundary is measured, not guessed. Add §3.3 or §12 and you are
reimplementing a relational engine in TypeScript.

> **Cross-check.** This section was written from a first-pass review, then independently
> re-derived by a second model reading the LanceDB and Lance-core sources directly. Both
> reached (d). The second pass supplied rows 6–8 above, the `update.rs` cost, and the
> §4.4(b) correction.

> What would overturn this: S8 (below) showing semantic recall materially beats trigram
> on a *memory-shaped* corpus. §4.4a's benchmark is **known-item retrieval on raw
> session transcripts** — not paraphrase-queried curated memories, which is v4's actual
> workload. The measurement is real; its transfer to this corpus is assumed, and that
> assumption has never been tested.

### 4.5 The LanceDB schema

One **dataset per bank**, at the path §4.3 derives. One **row per chunk**, not per
document.

```
table  chunks                        -- one Lance dataset per bank

  id              utf8        not null   -- '<memory_id>:<chunk_index>', deterministic
  memory_id     utf8        not null   -- FK into libSQL `documents` (not enforced here)
  chunk_index     int32       not null
  workspace_name         utf8        not null   -- ← redundant on purpose. §3.4.
  text            utf8        not null   -- the chunk as embedded, not the whole document
  vector          fixed_size_list<float32, D>  not null
  embedder        utf8        not null   -- 'bge-m3@1024' — model AND dim, one string
  status          int8        not null   -- 1 live, 0 withdrawn from default recall
  created_at      timestamp[us, UTC] not null
```

#### 4.5.1 Why these columns and not a metadata blob

v3's adapter carries `metadata: Record<string, string | number>` because it had to
satisfy five backends. v4 has one, so the filters get to be **real columns**: Lance
pushes predicates down to the scan, and a blob would force a full deserialise per row
to answer `WHERE workspace_name = ?`.

#### 4.5.2 `workspace_name` is stored even though the dataset is already per-bank

This is the §3.4 fail-closed backstop, and it is deliberate duplication. Path-derived
isolation fails open — one code path that builds a path without `resolveBank()` silently
opens the wrong dataset and **nothing errors**. With `workspace_name` on the row, every read
asserts it and a leak becomes a loud assertion failure instead of a wrong answer.

The assertion runs on results, not as a filter: filtering would *hide* the bug, which is
the failure mode this exists to prevent.

#### 4.5.3 `embedder` per row, not per dataset

`'<model>@<dim>'` as one string, because the dim is the half that breaks silently.

A bank re-embedded with a different model is a different corpus (spike S4). Storing the
identity per *row* rather than per dataset means a partial re-embed is detectable
mid-flight — which is exactly the state an interrupted backfill leaves behind. `bank_info`
reports the distinct set; more than one value means a re-embed is incomplete.

`D` in `fixed_size_list<float32, D>` is fixed at dataset creation and **cannot change
without rewriting the dataset**. Changing embedder to one of a different dimension is
therefore a new dataset, not a migration.

#### 4.5.4 `status` is denormalised from libSQL, and that is a known seam

Supersede lives in libSQL (§4.2) and is the record of truth. But `recall` must exclude
superseded chunks *inside the vector scan* — fetching k results and then filtering them
against libSQL returns fewer than k, unpredictably.

So `status` is mirrored into Lance, which means two stores hold one fact:

- `supersede()` writes libSQL **first**, then updates Lance
- an interruption between them leaves a chunk that is live in Lance and superseded in
  libSQL — it can surface in `recall` until reconciled
- **libSQL always wins.** The reconcile pass rewrites Lance from libSQL, never the
  reverse
- `bank_info` reports the count of rows whose `status` disagrees

This is the same consistency gap as the write path (§4.6) and it gets the same answer:
one reconciler, one direction, and a visible counter rather than a silent assumption.

> Note it is `status`, **not** a `superseded_by` copy. Lance holds the *decision*
> (include in default recall or not), never the supersede chain. The chain has one
> home.

#### 4.5.5 Chunk ids are deterministic

`'<memory_id>:<chunk_index>'`, so re-embedding a document is an idempotent overwrite
rather than an append that silently doubles its weight in recall. Retried writes — and
MCP clients do retry — must not duplicate a chunk.

#### 4.5.6 Python owns the Lance dataset; TypeScript only searches it

**Decision (2026-09-18, Nat): the vector side is Python.** The `chunks` schema above is
declared once, as a `lancedb.pydantic.LanceModel`, and that declaration is the only place
it exists:

```python
from lancedb.pydantic import LanceModel, Vector

class Chunk(LanceModel):
    id: str                  # '<memory_id>:<chunk_index>' — deterministic (§4.5.5)
    memory_id: str           # FK into libSQL. Not enforced here; Lance has no FKs.
    chunk_index: int
    workspace_name: str      # redundant ON PURPOSE — the fail-closed backstop (§4.5.2)
    text: str
    vector: Vector(1024)     # D is fixed at dataset creation and cannot change (§4.5.3)
    embedder: str            # 'bge-m3@1024' — model AND dim, one string
    status: int              # 1 live, 0 withdrawn
    created_at: datetime
```

**Why Python, when the runtime is Bun (§5).** The embedder already lives there —
`bge-m3` is a Python-ecosystem model, and step 2 of the write path is an embedding call.
Putting the Lance append in the same process as the thing that produces the vectors
removes a hop rather than adding one.

**Why this costs almost nothing: the language boundary sits on a seam that already
exists.** §4.6 returns from `remember` after step 1, with the row marked
`sync_state = 'pending'`; steps 2–4 are a scheduled reconciler pass. **That reconciler is
the Python worker.** It reads pending rows from libSQL, embeds, appends to Lance, and
writes back `sync_state`/`last_sync_at`/`sync_attempts`. No FFI, no shared process, no
cross-language ORM — the queue was already the interface, and it is now also the
language border.

```
  Bun / Elysia                     libSQL                    Python indexer
  ────────────                     ──────                    ──────────────
  remember()  ──INSERT────────▶  sync_state='pending'  ◀──── poll pending
    returns immediately                                      embed(text)
                                                             Lance append
                                 sync_state='synced'  ◀────  write back
  recall()  ──search()──────────────────────────────────────▶ (read-only)
```

**One owner, therefore one place the assertion runs.** §4.5.2 requires `workspace_name`
to be asserted on every read of a Lance result — not filtered, asserted, because filtering
would hide the bug. Two SDKs in two languages means two copies of that check and one of
them eventually drifts. With a single owner it is written once.

So TypeScript never declares the Lance schema and never writes to it. It calls one
read-only interface, the same shape and the same precedent as `SessionSource` (§14.6):

```ts
interface VectorStore {                          // external · read-only from v4's side
  search(bank: string, vector: Float32Array, k: number,
         filter?: { type?: string; status?: number }): Promise<ChunkHit[]>;
  health(): Promise<{ ok: boolean; datasets: number; detail: string }>;
}
```

**The honest cost:** one process boundary on the `recall` hot path. That is the trade —
a language border where the vectors are produced, in exchange for an IPC hop where they
are read.

> **This whole subsection is contingent.** §4.4d holds that LanceDB is **optional in v1**,
> and spike **S9** decides whether it is needed at all: if a libSQL brute-force scan over
> `F32_BLOB` with a `workspace_name` prefilter returns in under 50 ms at this corpus size,
> there is no second store, no Python worker and no IPC hop — and §4.4–4.7 collapse to
> about a page. Build none of this before S9 reports.

### 4.6 The write path — two stores, no transaction

`remember` touches three things that cannot share a transaction: a libSQL row, an
**external embedding call**, and a LanceDB append. A crash between any two leaves the
bank inconsistent, and the earlier draft said nothing about it.

**Order is chosen so that every failure leaves a state that is detectable and
repairable, never silently wrong:**

```
1. libSQL INSERT memory         (sync_state = 'pending')   ← the memory now exists
2. embed(text)                  external call
3. LanceDB append chunks        (deterministic ids, §4.5.5)
4. libSQL UPDATE               sync_state = 'synced', last_sync_at = now
   on any failure:             sync_state = 'failed',  sync_attempts += 1
```

| Crash after | State | Detected by | Repair |
|---|---|---|---|
| 1 | memory exists, no vectors | `sync_state = 'pending'` | backfill embeds it |
| 2 | same as above — embedding is not persisted | same | same |
| 3 | vectors exist, still `'pending'` | same | re-append is an **overwrite**, not a duplicate (§4.5.5) |
| 4 | consistent | — | — |

#### 4.6.1 Three columns on the row, not a reconciler table

The earlier draft tracked this with a single `indexed_at` timestamp. v4 uses Honcho's
three columns instead — `sync_state`, `last_sync_at`, `sync_attempts`
(`honcho/src/models.py:411–417`, on both `documents` and `message_embeddings`) — because
one timestamp cannot distinguish *never tried* from *tried and failed*, and cannot count
retries. `sync_attempts` is what lets the backfill give up on a poison row instead of
re-embedding it forever; `last_sync_at` still answers "when did the index catch up",
which is the number an embedder change (S4) needs.

**`remember` returns after step 1.** The document is durable and FTS-searchable
immediately; vector recall arrives when indexing completes. Blocking the caller on an
external embedder would make a memory server's write path only as available as its
embedding provider.

The reconciler is one scheduled pass, and it is the *same* one as §4.5.4 — it fixes
`sync_state <> 'synced'` and `status` disagreement together, always writing Lance from
libSQL. **libSQL is the record of truth; Lance is a derived index.** Losing the Lance
dataset entirely must be recoverable by re-embedding, and nothing else.

`bank_info` reports both counters — unembedded documents, and status disagreements. A
consistency gap the operator cannot see is one nobody fixes.

> `last_sync_at` is a timestamp rather than a boolean for the same reason `indexed_at`
> was: it records *when* the derived index caught up, which is what an embedder change
> (S4) needs in order to re-evaluate "caught up".

### 4.7 Concurrency

v1 assumes **one writer per bank**. Lance commits via manifest, and concurrent-writer
safety on object storage historically needs an external commit lock. Until §9-S2
settles this, the server serialises writes per bank in-process and documents the
single-writer assumption rather than pretending otherwise.

Reads are unrestricted and concurrent.

---

## 5. Runtime

### 5.1 Why not a Cloudflare Worker

`@lancedb/lancedb` is a **native** module (Rust bindings, filesystem/object-store IO).
The Workers runtime has no native addons. This is independent of where the *data*
lives: LanceDB-on-R2 still requires a process that can load native code.

This is the single hard constraint shaping the whole deployment story.

### 5.2 v1 shape — self-contained

```
┌──────────────────────────────────────────────┐
│  arra-oracle-v4   (one Bun process, Elysia)  │
│                                              │
│   MCP endpoint  /mcp/:bank[/:workspace]     │
│   HTTP API      /v4/...                      │
│   OAuth AS      /authorize /oauth/token      │
│   ├── metadata store  (SQLite)               │
│   └── LanceDB         (local dir  or  R2)    │
└──────────────────────────────────────────────┘
```

One process, `bun run start`, no sidecar, no docker-compose required. Elysia for
HTTP + MCP transport, matching the fleet's existing Bun/Elysia stack.

### 5.3 Reaching claude.ai

claude.ai must reach the endpoint over the public internet. Local-first does not mean
unreachable: a Cloudflare Tunnel or NetBird address in front of the same process is a
deployment concern, not a code concern.

### 5.4 Where Workers come back (later, optional)

A Worker can front v4 **without ever touching LanceDB**:

```
claude.ai ──OAuth──> [CF Worker: auth, rate limit, edge cache]
                            │  authenticated, signed
                            ▼
                     [Elysia process: MCP + LanceDB + R2]
```

The Worker owns tokens (D1, hashed) and terminates OAuth; the process owns data. This
is additive — v1 ships without it, and nothing in v1 needs rewriting to add it.

---

## 6. MCP surface

### 6.1 Protocol

- Transport: **Streamable HTTP** (the generation claude.ai's *Add custom connector*
  speaks). There is no MCP "v2" — the spec is date-revisioned.
- **Negotiate, don't pin.** Maintain a known-revisions list and answer an unrecognised
  client in the newest known revision rather than failing. (`digger-node` speaks five:
  `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.)
- **Per-bank endpoints**: `/mcp/:bank[/:workspace]` — **bank first, it is the tenant**
  (§3.1); the workspace segment is optional and narrows the room, never the isolation.
  A connector is scoped to one bank at
  registration time, so a model cannot address a bank it was not given.

### 6.2 Tools — v1

Small on purpose. Each must justify itself against "could the caller compose this from
two others?"

**Content**

| Tool | Purpose |
|---|---|
| `remember` | write a document into the connected bank |
| `recall` | trigram/FTS search, with semantic as an explicit separate mode (§4.4) |
| `get_document` | fetch one document by id, with provenance |
| `supersede` | mark a document superseded by another (or retire it with no replacement), with a reason |
| `supersede_chain` | walk a document's supersede history in either direction |
| `supersede_log` | what changed in this bank, time-ordered |
| `list_documents` | filter by type / term / project / time / **`untagged`**, paginated |
| `bank_info` | what this bank is, counts, embedder identity, health |

**Taxonomy** (§3.3) — the model is the classifier, so these are model-facing

| Tool | Purpose |
|---|---|
| `tag` | attach terms to a document. **This is where the guard lives** (§3.3.4) |
| `untag` | remove terms from a document |
| `term_list` | terms, optionally within one vocabulary, in weight order |
| `term_create` | add a term — **the deliberate way to add to a controlled vocabulary**. Idempotent by `(vocabulary, name)`; may create the vocabulary in the same call via `vocabulary_kind` |
| `term_weight` | set sort order within a vocabulary — what turns a controlled vocabulary into an ordered menu |
| `vocabulary_list` | vocabularies with their `kind` |
| `document_types` | the `type` strings actually in use — discovery, since `type` is free text |

**Observability** (§6.3)

| Tool | Purpose |
|---|---|
| `call_log` | recent MCP calls with arguments, outcome, result, duration — this server's own audit trail |
| `call_stats` | aggregate call counts and failure rates |
| `status` | deployment state in one object (§6.4) |

#### 6.2.1 Term references

Terms are addressed as `vocabulary:term` (e.g. `status:draft`). A bare name is resolved
only when unambiguous across vocabularies; ambiguity is a refusal that lists the
candidates, never a silent pick.

#### 6.2.2 Where the guard actually sits — and one place v4 may differ

**`digger-node` exposes `term_create` and `vocabulary_create` over MCP.** The protection
is not tool-hiding: it is that **`tag` refuses an unknown term in a `categories`
vocabulary** and names what does exist (§3.3.4). `term_create` is then the explicit,
auditable way to widen a controlled vocabulary, and the call log records who widened it.

That is a coherent position and v4 adopts it **by default**. But note the honest gap: a
model can, in two calls, `term_create` the term it wanted and then `tag` with it. The
controlled vocabulary is therefore a guard against *drift and typos* — `mcp` / `MCP` /
`model-context-protocol` — **not** a security boundary against a determined caller.

v4 makes that a **per-vocabulary policy** rather than a global assumption:

| `term_policy` | `term_create` over MCP | Use for |
|---|---|---|
| `open` (default, digger-node behaviour) | allowed | working vocabularies an agent curates |
| `sealed` | refused, returns §3.3.4 message | vocabularies whose term set is a contract (e.g. `status`) |

**Never MCP tools, in any policy:**

| Operation | Lives in | Why |
|---|---|---|
| create / rename / delete **bank** or **workspace** | HTTP API + CLI | a hallucinated `delete_bank` must have no path to exist |
| `vocabulary_delete` | HTTP API + CLI | cascades to every term and every tagging — too destructive for a model |
| changing a vocabulary's `kind` or `term_policy` | HTTP API + CLI | a model must not be able to widen its own constraints |

### 6.3 The call log — non-optional

Every MCP tool call is recorded: when, which tool, the input as sent, the outcome, and
the result. **Successes and failures both** — a call that errored is the one you most
want to read later.

> An MCP server you cannot watch is one you are trusting on faith. *"The model said it
> saved that"* is not evidence a row exists.

Inputs are truncated **at write time**, not at read time — otherwise a 100 KB argument
blob lives in the log forever and is only trimmed when someone happens to look.

Same idiom as everything else (§3.4.1) — and **`workspace_name` is a real column, not an
assumption.** v3's call log had no tenant column at all, which is one of the two isolation
holes §3.5 exists to close; a log that is "obviously scoped" without a column to prove it
is a log that leaks the moment one query forgets a join:

```ts
interface McpCall {
  id: string;                 // nanoid(21)
  workspace_name: string;     // NOT NULL, FK → workspaces.name — THE tenant column.
                              // v3's mcp_calls had none. §3.5.
  session_name: string | null;// FK (session_name, workspace_name) → sessions
  peer_name: string | null;   // FK (peer_name, workspace_name) → peers — who called

  tool: string;               // the tool name as invoked
  status: string;             // controlled term: 'ok' | 'error'
  duration_ms: number;

  h_metadata: object;         // input (truncated at write time) · result summary ·
                              // error message · connection id
  internal_metadata: object;

  created_at: number;
}
```

`status` is a column rather than a flag inside the bag because *"show me every call that
errored"* is the query this table exists to answer (§6.4), and a JSON probe cannot use an
index for it.

This is also the debugging surface that produced §3.3.4: both refusal-message fixes in
`digger-node` were found by *reading its own call log*, not by a test.

### 6.4 Health is a sentence, not a boolean

Following `digger-node`'s pattern, `/health` names the doors rather than saying "ok":

```json
{ "version": "...", "storage": "local|s3", "auth": ["api-token","oauth"],
  "banks": 3, "embedder": "…", "tools": 6 }
```

A claude.ai user learns *before* spending ten minutes that OAuth is off.

---

## 7. Auth

Two doors, because the clients genuinely differ:

| Client | Door | Why |
|---|---|---|
| Claude Code, scripts, curl | `Authorization: Bearer <API_TOKEN>` | can send a static header |
| **claude.ai** | **OAuth 2.1** | *cannot* send a static header — this is the entire reason the AS exists |
| Web UI (later) | owner session cookie | human at a keyboard |

OAuth requirements, non-optional:

- **Dynamic Client Registration** (RFC 7591) — claude.ai registers itself; there is no
  field to paste a `client_id` into
- **Authorization code + PKCE S256** — `plain` refused at issue time, not merely
  unadvertised
- **AS metadata** (RFC 8414) and **protected resource metadata** (RFC 9728) — the
  advertised `resource` must equal the URL the user typed, `/mcp/...` path included
- **`iss` on redirect** (RFC 9207)
- Codes single-use, 10 min. Tokens 30 days, no refresh tokens, no client secrets.
- Codes and tokens stored as **SHA-256 digests** — the row is as sensitive as the
  session it opens
- A refusal **does not redirect** — refusing by redirect reintroduces the open-redirect
  that exact-match `redirect_uri` checking exists to prevent

> Implementation is ported from `Soul-Brews-Studio/digger-node` (`src/` — OAuth AS on a
> Worker with D1). v4 reuses the **logic**, not the deployment target (§5.1).

### 7.1 Bearer auth — a first-class door, not a fallback

Bearer is not the lesser path. It is the **only** path for everything that can send a
header: Claude Code, `curl`, scripts, CI, the miner-style jobs that write on a timer.
OAuth exists solely because claude.ai cannot send one.

| | Bearer | OAuth |
|---|---|---|
| Who | Claude Code, scripts, CI | claude.ai connectors |
| Setup | paste a token into config | DCR + consent + PKCE |
| Rotation | issue a new token, revoke the old (§7.3) | 30-day expiry, re-consent |
| Scope | **per bank** (the tenant, §3.1), optionally narrowed to one workspace | bound to the `resource` it was issued for |

Tokens are stored as **`sha256(token)`, base64url** — never in the clear. The plaintext
exists exactly twice: in the response that hands it over, and in the `Authorization`
header coming back. Verification hashes the presented value and looks it up.

> The column is named `token_hash`, never `token`. digger-node renamed it rather than
> reusing the old name precisely because *"a column called `token` holding a digest is
> exactly the sort of quiet lie that survives into the next reader's assumptions."*
> A stolen database must yield nothing that can be replayed.

### 7.2 Who is connected — `connections`

"How many clients are connected, and is claude.ai among them?" is a question neither
the token table nor the call log can answer:

- `oauth_clients` knows who **registered** — a token that exists is not a client that calls
- `mcp_calls` knows which **tools ran** — a client can hold a session for hours and call
  no tool at all, and a browser or sidebar never calls one

So v4 keeps a third, small table — **a projection of the request stream, not a log**:

```ts
interface Connection {          // PRIMARY KEY: '<method>:<principal>'
  id: string;
  workspace_name: string;              // ← v4 adds this; digger-node is single-corpus
  method: 'bearer' | 'oauth' | 'owner-session';
  principal: string;            // token id or oauth client_id — NEVER the credential
  label: string;                // resolved at write time, so a renamed client shows its current face
  user_agent: string | null;
  remote_ip: string | null;
  first_seen: string;
  last_seen: string;
  requests: number;
  tool_calls: number;
  last_tool: string | null;
}
```

Folded on write: counters add, `last_*` replace, `first_seen` is kept. One row per
caller, not per request — a row per request would grow without bound to answer a
question about the present.

**Nothing here is a credential.** The bearer that proved a caller is discarded at the
gate; only the *method* survives.

### 7.3 Revocation

| Action | Effect |
|---|---|
| `revoke_token(id)` | one credential dies |
| `revoke_client(client_id)` | **everything that client holds** — live tokens *and* any authorization code still in flight |
| `revoke_workspace_tokens(ws)` | the panic button |

Revocation is a **hard delete of the credential row**, and this is a deliberate,
named exception to Principle 1 (§2.1): a revoked token that still exists somewhere is
not a historical record, it is a live risk. The *fact* of the revocation is retained —
who, when, which client — in the audit trail; the secret is not.

Revoking must also clear the matching `connections` row, or the UI keeps showing a
client that can no longer call.

> Because there are **no refresh tokens** (§7), revocation is genuinely final: a
> revoked claude.ai connector must be re-consented, not silently renewed.

### 7.4 Surfaces

| Where | Shows |
|---|---|
| HTTP API + CLI | full connections list, token list, revoke — **the only place revoke lives** |
| `/health` (§6.4) | counts only: doors open, connected clients in the last hour |
| MCP | **read-only** `connections` tool, scoped to the caller's workspace |

Revocation is **never an MCP tool.** A model must not be able to cut off another
client — or itself — and a hallucinated `revoke_workspace_tokens` must have no path to
exist. Same reasoning as bank/workspace lifecycle (§6.2.2).

---

## 8. Relationship to v3 — fresh start, no migration

**v4 starts empty. There is no data migration, and none is planned.**

| | |
|---|---|
| v3 data | stays in v3 |
| v3 service | keeps running, untouched, for as long as it is useful |
| v4 | begins with zero documents and earns its corpus |

This is a deliberate simplification, and it removes real work: no field mapping, no
tenant→bank assignment pass, no re-embedding run, no dual-run parity gate, no cutover
window. It also removes the single largest source of schedule risk in a rewrite.

**v3 is superseded in the Principle-1 sense** — succeeded, not deleted. It is not
switched off by this spec, and nothing here authorises removing it. If a corpus import
is ever wanted, it is a separate proposal against a v4 that already works.

> Studio note: [`ui-oracle/apps/studio/worker.ts`](https://github.com/Soul-Brews-Studio/ui-oracle)
> returns 404 for `/api/*` with *"static preview — the API backend only runs locally"*.
> v4 should either keep that honest posture or ship a genuinely reachable deployment —
> never silently inherit a dead API surface.

---

## 9. Spikes — must resolve before these become load-bearing

| # | Question | Why it blocks | Done when |
|---|---|---|---|
| **S1** | Does `@lancedb/lancedb` read/write an **R2** bucket via `s3://` + `endpoint`? | §4.3 assumes yes; undocumented by LanceDB | a table created, written, and queried against a real R2 bucket |
| **S2** | Concurrent-writer safety on object storage — is an external commit lock required? | §4.7 single-writer assumption is a workaround, not a decision | two writers against one bank on R2, observed conflict behaviour documented |
| **S3** | Does claude.ai's connector accept a **path-scoped** resource (`/mcp/:bank`)? | §6.1 per-bank endpoints depend on RFC 9728 `resource` exact-match with a path | a real claude.ai connector added and approved against a path-scoped URL |
| **S4** | Embedder choice for local-first (no API key) vs cloud | affects bank portability — a bank re-embedded with a different model is a different corpus | embedder identity recorded per bank, mismatch detected on read |
| **S5** | With `ORACLE_DB_SYNC_URL` **set** and the network **down**, does a write fail — and does `offline: true` actually rescue it? | §4.1 now states writes forward to the primary; the rescue path is documented but unverified. Testing the no-sync-URL case proves nothing | a write is attempted in all three modes of §4.1's table and each behaves as the table claims |
| **S6** | Does `tokenize='trigram'` FTS behave identically on **libSQL** as on stock SQLite FTS5? | §4.1.2 is load-bearing for Thai; a libSQL divergence would be silent. *(The LanceDB half of this question is closed — §4.1.2: character-level n-gram, already shipped and measured by this fleet.)* | ~~`ความ` returns the trigram order of magnitude (~435), not the `unicode61` one (~5)~~ — **superseded 2026-09-22: `ความ` is not a discriminator.** LanceDB `icu` finds it (it is a complete ICU token). Use `ลืม` against a stored `หลงลืม`: `icu` returns 0, `ngram(3,3)` returns the row. See §4.1.2 |
| **S7** | LanceDB fragment/version growth on R2 under single-row appends (§4.4c) | one commit per `remember` means object count and scan cost grow without bound; compaction policy is unspecced | 10k single-row appends on a real R2 bucket; object count, recall latency and `optimize()` cost measured |
| **S9** | **The one-hour experiment that settles §4.4d.** One Bun script: libSQL file, 10k real v3 documents (real Thai), `F32_BLOB(1024)`, `tokenize='trigram'`, **no vector index**. Measure (1) `ORDER BY vector_distance_cos(...) LIMIT 20` with a `workspace_name` prefilter, (2) `ความ` hit count — which also closes S6, (3) file size and `PRAGMA freelist_count` after 10k supersede UPDATEs | if (1) < 50 ms and (3) freelist ≈ 0, LanceDB has nothing to earn in v1 and §4.4–4.7 collapse to roughly one page | all three measured and recorded in this spec |
| ~~**S10**~~ | ~~What already indexes the `.jsonl` corpus?~~ **CLOSED 2026-09-18.** 7–8 indexers found; `session-viewer` owns `~/.session-viewer/sessions.db` as sole writer, `session-search` reads it. **v4 is a reader, not an eighth writer** — recorded in §14.9 | — | done |
| **S8** | Does semantic recall beat trigram on a **memory-shaped** corpus (curated memories, paraphrase queries) rather than raw transcripts? | §4.4d defers LanceDB entirely on the strength of §4.4a, whose benchmark is known-item retrieval on transcripts. If the transfer fails, LanceDB is load-bearing after all | ~200 curated memories, paraphrased queries, MRR for trigram vs bge-m3 reported side by side |

Nothing in §4.1, §4.3, §4.4c, §4.4d, §4.7, or §6.1 should be treated as settled until its
spike closes. **S9 is now the highest-value one** — it subsumes S6 and decides §4.4d outright.
**S6 alone is the cheapest** — it is a single query and it protects the
one defect v4 exists to not repeat.

---

## 10. Open questions for Nat

1. **Workspace granularity** — one workspace per oracle (`neo`, `digger`, `god`), or one
   per human/org with oracles as banks inside? The screenshot showed flat sibling banks;
   the answer decides whether `god-oracle` and `god-oracle-proof` are two banks in one
   workspace or two workspaces.
2. **Does v4 also absorb Hindsight?** Three systems currently ingest the same session
   transcripts (Hindsight banks, arra-oracle documents, Honcho peers) with no shared ID
   space. v4 replacing v3 leaves three. Replacing Hindsight too leaves two.
3. ~~**Licence**~~ — **decided: MIT** (2026-09-18), matching Hindsight. LICENSE committed.
4. ~~**One store or two?**~~ — **decided (2026-09-18): libSQL mandatory, LanceDB optional
   behind the §4.3 seam.** See §4.4d. Reopens only if **S8** shows semantic recall beats
   trigram on a memory-shaped corpus.
5. **`session-viewer` or `lanceglass` as the default `SessionSource`?** (§14.6) Both are
   real, running systems, not a hypothetical choice. `session-viewer` is proven on the one
   thing that matters most here — trigram FTS finds Thai inside words, the exact defect
   §4.1.2 exists to avoid. `lanceglass` (deployed as **Structor**) is running at fleet
   scale (6,402 sessions, 716,791 events, live 2026-09-18), watches **two machines**
   where `session-viewer` watches one, and already splits plain rows from vectors into
   separate LanceDB stores — independently converging on the exact shape v4 adopted for
   its own memories in §4.5.6. Untested: whether `lanceglass` matches trigram's Thai
   recall, or whether `SessionSource` should query both and merge. Nothing here decides
   this — it only names both candidates honestly instead of defaulting by omission.

---

## 11. Success criteria for v1

- [ ] A bank can be created, written to, and recalled from via the HTTP API
- [ ] The same bank is reachable from **Claude Code** over MCP with a bearer token
- [ ] The same bank is reachable from **claude.ai** via *Add custom connector* + OAuth
- [ ] Two banks in one workspace provably cannot see each other's documents — asserted
      by a test that tries and fails, not by inspection
- [ ] `ORACLE_STORAGE=local` → `ORACLE_STORAGE=s3` requires **zero code changes**
- [ ] A superseded document is absent from default recall and present with history on
- [ ] `/health` states storage, auth doors, bank count, embedder, tool count
- [ ] Whole tool surface explainable in under 8 minutes

---

## 12. Peers, sessions and messages

Ported from v3's forum (`forum_threads` / `forum_messages`) and fleet log
(`fleet_messages`), and joined to the fleet's existing presence transport.

### 12.1 Scope — v1 is sessions and chat, delivery comes later

**v1 builds the durable conversation. It does not build live delivery.**

| | v1 | Later |
|---|---|---|
| Entities — who exists (§12.2) | ✅ | |
| Threads + messages, searchable, taggable (§12.3) | ✅ | |
| Promotion: message → document (§12.3.1) | ✅ | |
| Unread cursor — "what's new for me" (§12.4) | ✅ | |
| Live push into a running session | | MQTT (§12.5) |
| Presence: online / offline | | MQTT retained + LWT (§12.5) |
| Delivery receipts | | §12.5 |

The model is designed **now** so that delivery drops in **later** without reshaping
anything — `DeliveryRef` exists in the type today with no implementation behind it.

#### The constraint that forces this split: MCP cannot push

**MCP is request-response.** A connector — Claude Code's or claude.ai's — is called; it
cannot wake an idle session. Anything described as "notification over MCP" is either
polling, or a different transport wearing MCP's name.

So v1's answer to "notification" is an honest one: **an unread cursor** (§12.4). A model
asks "what's new for me since X" when it runs. That is genuinely useful and completely
truthful about what it is — nobody is woken.

When real push is wanted, the fleet already has it and it is **MQTT, not MCP**. The
`oracle-channel` plugin delivers into a Claude Code session as
`notifications/claude/channel` — *channel messages, not tool calls* (§12.5). v4 will
publish to it and record the attempt; **v4 never becomes a broker**.

### 12.2 Entity — the registerable participant

An entity is a row in **`peers`** (§3.2) — `name`, `workspace_name`, `h_metadata`,
`configuration`, `created_at`, `UNIQUE (name, workspace_name)`. Nothing is added to it.
`kind`, `display_name`, `repo_url`, `mcp_url` and `last_seen_at` live in `h_metadata`
because none of them is joined on, constrained, or used in a query plan.

#### 12.2.1 Three columns, not eleven — and why `host` is inside the name

A draft of this gave Entity eleven columns: `host`, `slug`, `kind`, `display_name`,
`workspace_name`, `repo_url`, `mcp_url`, `channel_name`, `last_seen_at`, plus metadata. Honcho's
equivalent — `Peer` (`honcho/src/models.py:130`) — has **`name`, `workspace_name`,
`metadata`, `configuration`** and nothing else. It is a working multi-tenant memory
system; v4 is not more demanding than that, and eleven columns for an address book is
over-engineering.

So v4 keeps `name` and `metadata`. The reason this loses nothing:

- **`kind`, `repo_url`, `mcp_url`, `display_name`, `last_seen_at`** are descriptive. None
  is joined on, none is a constraint, none changes a query plan. They are metadata by
  definition.
- **`host` was never a separate fact.** This fleet's identity string is already
  `m5:arra-oracle-v3` — host-qualified, and it appears that way in **8,598** vault message
  headers. The full tag *is* the name. A separate `host` column would store the same
  information twice and invite the two copies to disagree. `mba:digger` and `m5:digger`
  are different names, therefore different rows, therefore different bodies under Rule 6
  — exactly the distinction we wanted, with no extra column.

**Registration is a write to v4; presence, when it exists, is read from the broker.** Keeping those
separate is deliberate: a registry that also claimed liveness would go stale silently
the moment a session died without deregistering — which is precisely the failure LWT
exists to prevent.

`slug` deliberately mirrors `oracle-channel`'s identity rule (default = basename of the
session's working directory, override `OC_NAME`) so one name addresses an entity in
both systems. v4 **must not** invent a second naming scheme.

> Identity collision is a real, observed failure: two live sessions sharing a name steal
> the broker connection from each other. v4 makes **`(workspace_name, name)`** unique,
> so it can at least *name* the collision rather than compound it.
>
> The host is *in* the name, not beside it — see §12.2.1.

### 12.3 Sessions and messages

Sessions are defined once in §3.2 and are **flat** (§3.1.1) — no `threads` table, no
`parent_id`. `name` is the session's name; `room`, `issue_url`, `issue_number` and
`project` live in `h_metadata`. Messages hang off a session directly, and nest among
themselves via `in_reply_to`.

A message is a row in **`messages`** (§3.2): Honcho's columns plus four nullable v4
additions — `role`, `in_reply_to`, `read`, `read_at`. `peer_name` is a composite foreign
key into `peers`, never a free-text name. `seq_in_session` is unique per room, so order is
a constraint rather than a hope.

> **`read` / `read_at` are not an invention.** A survey of this fleet's vault
> (2026-09-18) found them on **8,597 files** — `from`, `to`, `timestamp`, `read`, `readAt`
> is the de-facto message schema already running at roughly 8,600 records across
> `inbox/` and `inbox/archive/`. §12.4 originally specced unread as a *derived* query;
> production already stores it per message, and a derived version cannot express "read
> at 13:15 in a batch sweep", which the corpus does record. Adopt the existing shape.

Three deliberate choices:

1. **`peer_name` is a foreign key, not a string.** v3's `forum_messages.author` and
   `fleet_messages.from_id` are free text, so "who said this" cannot be answered by a
   join — only by string-matching names that drift. Entities exist to fix that.
2. **Threads and messages wear terms** (§3.3) like documents do. A conversation is
   classifiable content; `status:resolved` is a controlled term, not a second enum
   invented here.
3. **Messages are FTS-indexed with `trigram`** (§4.1.2). A fleet conversation in Thai is
   exactly the case `unicode61` loses.

#### 12.3.1 Denormalise the ancestry onto the message — Honcho's pattern

`Message` carries `workspace_name` even though it is reachable through `session_name`. This is
deliberate and it is copied: Honcho's `Message` (`honcho/src/models.py:206`) stores
**`workspace_name`, `session_name` and `peer_name` all on the row**, so the overwhelmingly
common query — "messages in this tenant" — is single-table with no join.

For v4 it does a second job: it puts `workspace_name` on the message row, which makes the
message table obey §3.4's fail-closed rule the same way documents do. A message you can
only attribute to a bank *by joining* is a message a forgotten join can leak.

`seq` is Honcho's `seq_in_session` (`models.py:227`): an explicit monotonic integer per
room, because ordering by timestamp ties under fast writes and `created_at` is not unique.

#### 12.3.2 Promotion — the point of storing chat next to memory

A message worth keeping becomes a document:

```
promote(message_id, workspace_name, type) → Memory
```

The document records the message as its `origin`, so provenance runs
`document → message → thread → entity`. This is the whole reason a memory server hosts
conversations at all: **the interesting things get said in chat, and today they die
there.** Promotion is explicit and human/agent-triggered — v4 never auto-promotes,
because a store that decides for itself what was important stops being a mirror.

### 12.4 "What's new for me" — the v1 notification story

No push, no lying about push. Each entity carries a read cursor per thread:

```ts
interface ReadCursor {                 // PRIMARY KEY (peer_name, session_name)
  peer_name: string;
  session_name: string;                // the thread (§3.1.1)
  last_read_message_id: string | null;
  last_read_at: string;
}
```

`inbox(entity)` returns threads with unread messages, newest activity first, with the
unread count per thread. An oracle calls it when it wakes; a human UI calls it on load.

This is deliberately *pull*. It is honest, it needs no broker, and it keeps working when
every other moving part is down. When MQTT lands (§12.5), push becomes an
**accelerator** on top of the cursor — never a replacement for it, because a session
that was offline during the publish must still find the message.

### 12.5 Later: delivery over MQTT — designed in, not built

Deferred from v1. Specified now only so v1 does not foreclose it.

`notify(entity, room, text)` will do two things, in this order:

1. publish to `oracle/<channel_name>/<room>/in` on the existing broker
2. write a `DeliveryRef`

```ts
interface DeliveryRef {                // exists in the model from v1; unimplemented
  peer_name: string;
  topic: string;
  published_at: string;
  outcome: 'published' | 'no-channel' | 'refused' | 'error';
  detail: string | null;
}
```

Rules that apply the moment it is built:

- **A publish is not a read receipt.** `published` means the broker accepted it, nothing
  more. Any tool response implying the recipient *saw* it is lying — the fleet has
  already been bitten by treating `queued` as delivered.
- **Presence is read, never asserted.** Online/offline belongs to MQTT retained state +
  LWT. When the broker is unreachable, presence is `unknown` for every entity — never
  silently `offline`, which would read as a fact v4 cannot know.
- **The message persists in the thread regardless of outcome.** `no-channel` is a normal
  result, not a failure: the conversation surviving an offline recipient is exactly the
  durability MQTT alone does not provide.

### 12.6 MCP tools for this surface

**v1**

| Tool | Purpose |
|---|---|
| `entity_register` | register/update an entity in this workspace |
| `entity_list` | the address book |
| `thread_create` | open a conversation |
| `thread_list` | filter by status / room / project / term / participant |
| `thread_read` | a thread with its messages, paginated |
| `post` | add a message to a thread |
| `inbox` | threads with unread messages for an entity (§12.4) |
| `mark_read` | advance an entity's cursor on a thread |
| `promote` | turn a message into a document in a bank (§12.3.1) |

**Later**: `notify` (§12.5), and presence merged into `entity_list`.

### 12.7 What this explicitly does not do

- **No auto-promotion.** See §12.3.1.
- **No routing/rules engine.** `hook-lance` already does webhook→rule→forward; v4 must
  not grow a second one.
- **No ingest of maw/discord/git/vault logs.** v3's `fleet_messages` did that and it is a
  separate concern; v4 stores conversations it *participates in*, not everything that
  ever moved.
- **No presence assertion** — even after §12.5 lands. The broker owns liveness.
- **v4 is never a message broker.** It is the durable, queryable, taxonomy-aware record
  the broker has always been missing.

---

## 13. Provenance

Every non-obvious claim in this spec traces to one of the following. Nothing here is
recalled from general knowledge; it was read or measured on 2026-09-18.

### 13.1 Prior art — repositories

| What it gave v4 | Repository | Read locally at |
|---|---|---|
| Document model, supersede, bitemporal, path-derived isolation, LanceDB adapter | <https://github.com/Soul-Brews-Studio/arra-oracle-v3> | `/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v3` |
| **The entire taxonomy model (§3.3)** — Drupal's four nouns, the `kind` policy, hierarchy+weight, refusal wording, "the model tags, not the person"; plus OAuth 2.1 AS for claude.ai, MCP multi-revision negotiation, the call log, `/health` names doors | <https://github.com/Soul-Brews-Studio/digger-node> | `/opt/Code/github.com/Soul-Brews-Studio/digger-node` |
| Second live implementation of the same node/term model, reachable as an MCP server | `digger-kvmlab1` (`http://kvmlab1.oracle.netbird:8108/mcp`) — same 19-tool surface | — |
| Bun-server + LanceDB runtime shape; bearer-for-Claude-Code + OAuth-for-claude.ai | <https://github.com/Soul-Brews-Studio/hook-lance> | `digger-oracle/ψ/lab/hook-lance-haos` |
| Workspace-as-tenant concept (rejected peer/representation model) | <https://github.com/plastic-labs/honcho> (AGPLv3) | `/opt/Code/github.com/plastic-labs/honcho` |
| Bank-as-isolated-brain concept (rejected disposition traits) | <https://github.com/vectorize-io/hindsight> (MIT) | `/opt/Code/github.com/vectorize-io/hindsight` |
| Frontend precedent + the "static preview" trap | <https://github.com/Soul-Brews-Studio/ui-oracle> (BUSL-1.1) | `/opt/Code/github.com/Soul-Brews-Studio/ui-oracle` |
| Metadata engine, embedded replicas | <https://github.com/tursodatabase/libsql> | — |
| CalVer scheme (§Versioning) | <https://github.com/Soul-Brews-Studio/arra-oracle-skills-cli> | `~/.claude/skills/calver` |

### 13.2 Specific citations

| Spec claim | Source |
|---|---|
| Vector isolation by path; adapter deliberately tenant-blind | `arra-oracle-v3/src/vector/factory.ts:75` (`tenantDataPath(... LANCEDB_DIR)`); zero `tenant` refs in `src/vector/adapter.ts`, `src/db/vector-schema.ts` |
| v3 already ships LanceDB + a proxy boundary | `arra-oracle-v3/package.json` → `"@lancedb/lancedb": "^0.27.2"`, script `vector:proxy`; `src/vector/proxy-protocol.ts`, `src/vector-server.ts` |
| MCP is date-revisioned; negotiate rather than pin | `digger-node/src/mcp.ts` → `KNOWN_PROTOCOL_VERSIONS = ["2026-07-28","2025-11-25","2025-06-18","2025-03-26","2024-11-05"]` |
| Taxonomy schema — four nouns, `kind IN ('tags','categories')`, `parent_id`, `weight`, `UNIQUE(vocabulary_id, name)`, `type` free-text not enum | `digger-node/migrations/0001_init.sql` (squashed deliberately: "a new deployment should not have to replay someone else's education") |
| Live tool surface this is modelled on (19 tools) | `digger-node/src/mcp.ts` → `node_create/update/delete/get/list/search/tag/untag/types/embed`, `term_create/list/weight`, `vocabulary_create/list/delete`, `call_log`, `call_stats`, `status` |
| Controlled-vocabulary refusal is the point of the `kind` column | `digger-node/src/mcp.ts:297` — *"Free-tagging creates; a controlled vocabulary refuses and lists what it does have."* |
| Both refusal-message fixes were found by reading the call log, not by tests | [`digger-node/docs/README.md`](https://github.com/Soul-Brews-Studio/digger-node/blob/main/docs/README.md) — "Who tags: the model, not the person" |
| Trigram FTS + external-content triggers; `unicode61` swallows a Thai sentence as one token | `digger-node/migrations/0001_init.sql` — "measured independently four times across this fleet" |
| claude.ai cannot send a static header → OAuth is mandatory; DCR, PKCE S256, RFC 8414/9728/9207; SHA-256 token storage; refusal must not redirect | [`digger-node/docs/connect-claude-ai.md`](https://github.com/Soul-Brews-Studio/digger-node/blob/main/docs/connect-claude-ai.md) |
| Per-bank MCP endpoint precedent | `god-oracle/src/hindsight-miner/mine.sh` → `HINDSIGHT_MCP=http://localhost:8890/mcp/god-oracle` |
| Hindsight bank fields (`workspace_name`, `mission`, disposition) | `hindsight-clients/python/hindsight_client_api/models/bank_profile_response.py`, `disposition_traits.py` |
| Honcho workspace = root tenant | `honcho/src/models.py:Workspace` |
| LanceDB S3-compatible addressing (`s3://`, `endpoint`, `region`, `allow_http`) | <https://docs.lancedb.com/storage/configuration> — **R2 is not named there**; §4.3 remains unverified (spike S1) |
| LanceDB is native → cannot run in a CF Worker | `@lancedb/lancedb` ships Rust bindings; Workers have no native addons |

### 13.3 Measurements — this fleet, not vendor claims

| Measurement | Value | Where |
|---|---|---|
| Known-item retrieval MRR, 124,049 session blocks, n=200 k=20 | FTS **0.765** · bge-m3 0.099 · MiniLM 0.063 · hybrid RRF 0.437 | pulse-oracle#155, #157, #156; digger-oracle#7 |
| Vector/FTS top-10 Jaccard overlap | 0.009–0.018 | same |
| Thai under `unicode61` vs `trigram` | `ความ` → 5 hits vs **435** | same |
| Trigram index cost | 1.79× | same |
| libSQL DiskANN freelist leak | 92 GB file / 4.2 GB live data; 23.1M of 24.2M pages freelist | `ψ/lab/turso-agents-index`, measured 2026-09-17 |
| v3 FTS ships `unicode61`-only | structurally cannot find Thai inside words | noted in the same measurement set |

### 13.4 Session trace — how this spec was produced

Written 2026-09-18, session `53a8949c`, 06:06–07:00 GMT+7, from these artifacts
produced the same morning:

| Artifact | Path |
|---|---|
| `/learn` — plastic-labs/honcho (5 docs) | `neo-oracle ψ/learn/plastic-labs/honcho/2026-09-18/0612_*.md` |
| `/learn` — arra-oracle-v3 (5 docs) | `neo-oracle ψ/learn/Soul-Brews-Studio/arra-oracle-v3/2026-09-18/06{18,21}_*.md` |
| `/learn` — vectorize-io/hindsight (3 docs) | `neo-oracle ψ/learn/vectorize-io/hindsight/2026-09-18/0640_*.md` |
| `/ralph-dig` #256 — honcho MCP | `digger-oracle ψ/ralph/honcho-mcp.md` |
| `/ralph-dig` #257 — fleet MCP servers | `digger-oracle ψ/ralph/mcp-servers.md` |
| dig log rows | `digger-oracle ψ/ralph/.dig-log.md` (#256, #257) |
| `/oracle-prism --preset design` — 5 lenses on this design | session `53a8949c` transcript |
| session retrospective | `neo-oracle ψ/memory/retrospectives/2026-09/18/06.43_mcp-recon.md` |
| lessons | `neo-oracle ψ/memory/learnings/2026-09-18_learn-{honcho,arra-oracle-v3,hindsight}.md` |

Incubation breadcrumb: `.claude/INCUBATED_BY` in this repo records the oracle, date and
source. Vault shared at `ψ →` neo-oracle's vault.

---

*Written by an Oracle — AI speaking as itself (Rule 6).*
*Spec `v26.9.18-alpha.700` · bump with `/calver --apply`.*

---

## 14. Traces

v3's `trace_log` is the one subsystem with no equivalent anywhere else in this fleet, and
the thing most likely to be lost in a rewrite. It is also **two systems that drifted
apart**, which is the first thing this section has to fix.

### 14.1 What a trace is — and the drift that has to be reconciled

A **trace** is the record of a *search*: what was asked, what it found, and what it
became. v3 stores that twice, in two places that share almost nothing:

| | `trace_log` table (`arra-oracle-v3/src/db/schema.ts:171`) | `ψ/memory/traces/*.md` (72 files, surveyed 2026-09-18) |
|---|---|---|
| Identity | `trace_id` UNIQUE | filename `HHMM_kebab-slug.md` under `YYYY-MM-DD/` |
| The question | `query`, `query_type`, `scope` | `query` **72/72**, `target` **72/72**, `mode` **72/72** |
| **The graph** | `parent_trace_id`, `child_trace_ids[]`, `prev_trace_id`, `next_trace_id`, `depth` | **absent as fields** — links are relative paths inside a trailing `## Oracle Memory` section |
| **The lifecycle** | `status: 'raw'`, `distilled_to_id`, `distilled_at` | **present but unmarked** — direction inferred only from where the link sits in the file |
| **Quality** | *(no column)* | `confidence` 30/72, `friction_score` 26/72, `coverage` 23/72 |
| Cost | `agent_count`, `duration_ms` | `agents` 18/72, `session` 7/72 |
| What it found | six `found_*` JSON blobs + three counts | Markdown tables and bullets, **~95% machine-extractable** |

Neither is a superset. **v4 takes the union**, and the three columns the table never had
are the most interesting ones.

> **`friction_score` is the idea worth keeping.** A trace that was hard to satisfy is a
> statement about the *corpus*, not about the search. It is the only signal in this fleet
> that points at what the memory is missing, and it exists in 26 files with no schema
> behind it. v4 gives it one.

### 14.2 `traces`

Same idiom as tier 1 and tier 2 (§3.4.1): filter keys are columns, everything else is in
the bag.

```ts
interface Trace {
  id: string;
  name: string;               // slug — the vault already names these `HHMM_kebab-slug`.
                              // UNIQUE (name, workspace_name), Honcho's idiom.
  workspace_name: string;     // NOT NULL — a search runs against one bank (§3.4)
  session_name: string | null;// which room it ran in, if any. Organisation, not scope.
  peer_name: string | null;   // who ran it. FK (peer_name, workspace_name) → peers

  query: string;              // what was asked
  mode: string;               // free text, like `type` (§3.2). Observed: deep, smart,
                              // synthesis, deep-dig, 'deep --dig'. NOT an enum — the
                              // vault proves it is a free-form field in practice.

  session_id: string | null;  // the .jsonl UUID. No FK — it lives outside (§14.6.1).

  friction_score: number | null;  // 0.0–1.0, how hard this was to satisfy. A column
                                  // because it is the one signal that points at what
                                  // the corpus is MISSING, and you sort by it (§14.1).
  confidence: string | null;      // controlled term, not free text (§3.3) — a column
                                  // because the normalisation map below is enforceable
                                  // only on something you can group by.

  // the graph — ONE source per edge, see §14.4
  parent_id: string | null;   // FK → Trace. Tree.
  prev_id: string | null;     // FK → Trace. Sequence.
  depth: number;

  // the lifecycle
  status: string;             // controlled term: 'raw' | 'distilled' | 'retired'
  distilled_to: string | null;    // FK → Memory
  distilled_at: number | null;

  h_metadata: object;         // target · project · coverage · agent_count · duration_ms
  internal_metadata: object;

  created_at: number;
  updated_at: number;
}
```

**What left, and why** — the same filter-key-or-display-field test as §3.4.1:

| Field | Disposition | Reason |
|---|---|---|
| `scope` | **cut** | v3's SQL had it; the 72-file vault survey (§14.1) measured `query`, `target` and `mode` at **72/72** and never established a rate for `scope` at all. `target` (what it aimed at) and `project` cover the ground. A column inherited from a schema rather than from evidence is exactly what Principle 2 says not to carry forward |
| `coverage` | → `h_metadata` | 23/72, and no definition that distinguishes it from `confidence` in practice. Reported, never filtered |
| `target`, `project` | → `h_metadata` | displayed on every trace, filtered on approximately never |
| `agent_count`, `duration_ms` | → `h_metadata` | cost telemetry. Read in aggregate reports, not in `WHERE` clauses |
| `actor_peer_name` | **renamed** `peer_name` | Honcho calls this column `peer_name` in `messages` and `session_peers`. One fleet, one word |

Traces wear terms (§3.3) like memories do.

**`mode` is free text; `confidence` and `status` are controlled.** The spec has to be
explicit about which, because the corpus disagrees with itself:

| Field | v4 | Observed in the vault | Why |
|---|---|---|---|
| `mode` | **free text**, like `type` (§3.2) | `deep` (56), `smart`, `synthesis`, `deep-dig`, `deep --dig`, `deep (main-agent only…)` | these are invocation strings, not a classification. A new search mode must be a string a client picks, never a migration |
| `confidence` | **controlled term** | `high`, `medium`, `medium-high`, `HIGH`, `PROVEN` in 30 files | five spellings of three states — exactly the casing rot §3.3.1 exists to stop |
| `status` | **controlled term** | `raw` | one axis every caller filters on |

The importer therefore carries **one explicit normalisation map** for `confidence`
(`HIGH`→`high`, `PROVEN`→`high`, `medium-high`→`medium`), applies it once, and records
the original string in `metadata` so the mapping is auditable rather than lossy. It must
**not** normalise `mode` — `deep --dig` and `deep` are different invocations and
collapsing them destroys the distinction.

### 14.3 `trace_hits` — what was found, normalised

v3 stores results as six parallel JSON blob columns (`found_files`, `found_commits`,
`found_issues`, `found_retrospectives`, `found_learnings`, `found_resonance`). They are
unqueryable: *"which traces found file X"* requires a full scan and a JSON parse per row.

One join table replaces all six:

```ts
interface TraceHit {              // PRIMARY KEY (trace_id, kind, ref)
  trace_id: string;               // FK → Trace, ON DELETE CASCADE
  kind: string;                   // controlled term — see the table below
  ref: string;                    // the reference itself, canonical form
  line_start: number | null;      // when kind='file' and a range was cited
  line_end: number | null;
  note: string | null;            // the one-line "why this matched"
  position: number;               // order as presented
}
```

The reference forms are already regular in the corpus — measured across all 72 trace
files, **~95% cleanly extractable**:

| `kind` | Observed form | Real example |
|---|---|---|
| `file` | `path:line-line` | `src/ssh.ts:69-100` |
| `commit` | 7-char hash | `6b65f67` |
| `issue` | bare `#NN` | `#26` |
| `issue` | qualified | `laris-co/1x-data-flow-mind-grid #15` |
| `repo` | `org/repo` | `laris-co/webhook-relay` |
| `document` | vault-relative path | `ψ/memory/learnings/2026-03-08_session-6-mobile-ux.md` |

> The measured 5% of noise is one specific collision: **"GitHub Action #161" is
> indistinguishable from issue #161 without surrounding context.** The importer must
> read the context word or emit `kind='ref-ambiguous'` — it must not guess, because a
> wrong `kind` is silently wrong forever.

`(trace_id, kind, ref)` as the primary key makes re-importing a trace idempotent, which
matters because these files are re-read on every backfill.

### 14.4 The graph — one source per edge

v3 carries `parent_trace_id` **and** a denormalised `child_trace_ids[]` JSON array for
the same edge, plus `prev_trace_id` and `next_trace_id` for the same sequence. Two
writable sources per edge means they can disagree, and nothing detects it.

**v4 stores each edge exactly once and derives the other direction:**

| Edge | Stored | Derived |
|---|---|---|
| tree | `parent_id` | children = `WHERE parent_id = ?` |
| sequence | `prev_id` | next = `WHERE prev_id = ?` |

`trace_chain(id)` walks both. `child_trace_ids` and `next_trace_id` do not exist as
columns. This costs one index each and removes a whole class of silent inconsistency.

### 14.5 Distill — the same act as `promote`, finally named once

v3 has `oracle_trace_distill` (trace → document). §12.3.1 has `promote` (message →
document). They are one mechanism with two names, and the vault shows the cost of never
saying so: distillation is **present but unmarked** — a trace links its learnings and
retros in a trailing `## Oracle Memory` section, and the *direction* of the relationship
is inferable only from where the link happens to sit in the file. Nothing can query it
backwards. *"Which trace produced this learning?"* is unanswerable today.

v4 defines one verb:

```
distill(source_id, source_kind: 'trace' | 'message', workspace_name, type) → Memory
```

- the new Memory records its origin (`origin`, plus `source_file` when it came from a file)
- the source records `distilled_to` and `distilled_at`
- `status` moves `'raw' → 'distilled'`
- it is **explicit and human/agent-triggered.** v4 never auto-distills, for the same
  reason §12.3.1 never auto-promotes: a store that decides for itself what mattered has
  stopped being a mirror (§2, Principle 3).

#### 14.5.1 Chained distillation — 1st/2nd/3rd order, and the timestamp is what's true

`distill()` is not limited to raw material. Its `source_id` can be another **trace** —
`source_kind: 'trace'` already allows it — so a first-order trace (ran against a session,
`depth = 0`) can itself be distilled into a second-order trace (`parent_id` → the first,
`depth = 1`), and that into a third. **No new table.** This is §14.4's graph, walked more
than once: `trace_chain(id)` already answers "what did this come from" at any depth; it
does not care whether the parent is raw or itself a summary.

**What has to be added is the anchor, because a chain of summaries is exactly the
transmission-fidelity problem §14's own research keeps surfacing.** A third-order summary
is three paraphrase-steps from the session it claims to describe. Without an anchor, "what
does this claim rest on" degrades the same way an isnād does with a broken link (§14, faith
research 2026-09-18) — except here nothing marks the break.

**The anchor is the timestamp range, not the summary prose:**

```ts
interface Trace {
  ...
  session_id: string | null;      // existing — the .jsonl UUID, no FK (§14.6.1)
  session_from_ts: number | null; // NEW — earliest raw event this trace (at any depth)
  session_to_ts:   number | null; // NEW — traces back to. min/max of children's range.
  ...
}
```

Real columns, not `h_metadata` — this is the one place the §3.4.1 filter-key test forces
it: *"what covers this time window"* is a query v4 needs to answer, not merely display.

**The rule, stated once:** a trace's prose — `query`, and anything a distilled `Memory`
says — is a **convenience**. The `(session_id, session_from_ts, session_to_ts)` triple is
what a human verifies a claim against, by going to the actual transcript at that range
(§14.6, `SessionSource.read`). A second- or third-order summary that has drifted from its
source is still **checkable**, because the anchor does not drift — it is copied forward
unchanged at every distillation, the same way `supersede_log` snapshots `old_title` rather
than trusting a join (§4.2.2). Depth compounds paraphrase. It must never compound
uncertainty about *where the paraphrase came from*.

### 14.6 Session mining lives outside — v4 queries it, v4 does not store it

**Decision (2026-09-18, Nat): no `transcripts` table, no `insights` table.** An earlier
draft specced both — a row per `.jsonl` file with `raw_path`, byte-offset tail state, a
generated summary, `trace_count`, plus an `insights` table with anchors back into the
transcript. It is cut. Two reasons, and the second is the real one:

1. **It was becoming a second product inside the spec** — a mining scheduler, a
   summariser, an extractor, a tail-follower, a rotation detector. None of that is a
   memory bank.
2. **Seven or eight tools on this fleet already index that corpus**, measured 2026-09-18.
   `session-viewer` is the sole writer of `~/.session-viewer/sessions.db`;
   `session-search` reads it. Adding a v4 table would make **v4 the eighth writer over
   one corpus of 38,838 files and 21 GB**, with its own drift, its own backfill, and its
   own answer to "what is a session summary".

**Three concrete implementations, not a hypothetical category.** Since the S10 survey,
one of the seven-to-eight turned out to matter more than the others for this decision:

| Provider | What it actually is | Measured, this session |
|---|---|---|
| `session-viewer` | single-machine, `sessions.db`, **trigram FTS5** | the only one proven to find Thai inside words (§4.1.2's own defect, fixed) |
| **`lanceglass`** (`Soul-Brews-Studio/lanceglass`, deployed as **Structor**) | JSONL → typed LanceDB, **plain-rows store and vector store physically separate** — the exact split v4 just adopted for its own memories in §4.5.6, independently | live and running: **6,402 sessions · 716,791 events**, `lance-py` embedding backfill at 94,701/716,791 (pending/synced, same shape as §4.6.1), watchers on **two machines** (`watch-local`, `watch-kvmlab1`) |
| `jsonl-indexer` (MCP, `nat-build-with-oracle` lab) | small, MCP-native — callable as a tool with no HTTP hop | 26,947 rows, 14 projects — lab-scale, not fleet-scale |

Lanceglass/Structor is not a hypothetical fourth option: it is a **running system,
independently converging on v4's own §4.5.6 architecture**, multi-machine where
`session-viewer` is single-machine. It was counted in S10's "7–8" but not compared
against the incumbent. That comparison is now **§10, open question 5** — this section
keeps `session-viewer` as the documented default only because trigram-Thai is a proven,
specific strength and nothing here has tested whether Lanceglass matches it, not because
the comparison has been run.

**So v4 is a client.** A session index is an **external service** behind one interface,
and v4 ships with no implementation of it beyond a reader for the index that already
exists.

```ts
interface SessionSource {                       // external · pluggable · read-only
  find(query: string, limit?: number): Promise<SessionRef[]>;
  get(session_id: string): Promise<SessionRef | null>;
  read(session_id: string, from?: number, limit?: number): Promise<Excerpt[]>;
}

interface SessionRef {
  session_id: string;        // the .jsonl UUID — also the filename
  host: string;              // m5 | mba | white. A path means nothing without it.
  project_encoded: string;   // the directory name, verbatim — the only reliable key
  project_path: string | null;   // best-effort decode. NULLABLE — see below.
  started_at: number;
  ended_at: number | null;
  message_count: number | null;
  title: string | null;      // read, not generated — see below
  source: string;            // which provider answered: 'session-viewer' | …
}
```

Configured, not compiled in:

```
ORACLE_SESSION_SOURCE=session-viewer
ORACLE_SESSION_DB=~/.session-viewer/sessions.db     # read-only. v4 never writes it.
```

Unset ⇒ the surface reports `"session source: not configured"` and session-linked
features degrade. They do not fail, and they do not silently return nothing (§6.4).

#### 14.6.1 The only durable link: `traces.session_id`

The one fact v4 keeps in its own database is which session a trace ran in — a single
`TEXT` column on `traces` (§14.2), holding the `.jsonl` UUID. No foreign key, because the
referent lives in another system and may be archived or deleted.

That column alone answers what the fleet census found **nothing** currently answers:

| Question | Before | With `traces.session_id` |
|---|---|---|
| which memories came out of this session? | unanswerable | `traces → distilled_to → memories` |
| how many times has this session been traced? | unanswerable | `SELECT count(*) FROM traces WHERE session_id = ?` |
| where did this memory come from? | unanswerable | `memories.origin → trace → session` |

"How many times traced" is therefore a **query, not a counter**. An earlier draft cached
it as `transcripts.trace_count`; a cached count over a table v4 already owns is a second
source of truth for a `count(*)` that costs nothing.

#### 14.6.2 Two facts the external interface must not get wrong

**The path encoding is lossy.** A project directory like
`-opt-Code-github-com-laris-co-neo-oracle` is the real path with **both `/` and `.`
replaced by `-`**. Verified on this machine 2026-09-18: **155 project directories contain
`github-com`** — a destroyed dot — and **zero** retain a literal dot. So `a.b/c` and
`a/b/c` encode identically. **`project_encoded` is the key; `project_path` is a
best-effort decode that may be `NULL`.** Never key on the decode.

**A title is read, not invented.** Claude Code transcripts carry no session summary
record, but they do carry an optional `custom-title` record. `SessionRef.title` surfaces
that when present and is `null` otherwise. v4 does **not** generate summaries — a
generated summary is an unattributable claim unless it also carries the model and
timestamp that produced it, and that machinery is exactly what §14.6 just declined to own.

### 14.7 The import filter — mandatory, and the spec owes it a page

A survey of this fleet's own vault (2026-09-18, 20 agents over 10,073 markdown files)
found three things that would each, on their own, wreck a naive bulk import:

| Finding | Measured | Consequence |
|---|---|---|
| **The corpus is mostly messages, not documents** | `from`/`to`/`timestamp`/`read` on **8,598** files; the knowledge keys (`source` 566, `tags` 459, `title` 455, `concepts` 123, `pattern` 101) on roughly 600 | ingesting everything as `Memory` mislabels 85% of the corpus. Inbox files are `Message` (§12.3) |
| **43% near-duplicate rate in dispatch logs** | 388 near-identical templates across one 888-file slice — `starting #N`, `done <sha>`, `PR #N merged` | machine chatter buries the ~637-file `memory/` tree. Dedupe on normalised body hash before insert |
| **The tag vocabulary is contaminated by test fixtures** | top values `learn` 372, then `visible` **116**, `deleted` **116**, `crud` **116** — three tags at an identical count are a CRUD test suite, not concepts. Real concepts begin at `codebase` 19 | seeding a controlled vocabulary (§3.3.1) from the raw corpus would import the test suite as taxonomy |

Two further facts the importer must handle rather than discover:

- **20.7% of the corpus contains Thai** (2,088 of 10,073 files; `ความ` in 148). This is
  the §4.1.2 trigram requirement restated as a measurement, and it includes 17 of the 72
  trace files.
- **Status is carried by the directory, not the content.** `inbox/archive/` and
  `archive/` mark retirement by *path only* — no file body says it is archived. Only
  `plans/` carries an in-content `status: SUPERSEDED` with a cross-reference. An importer
  reading bodies alone cannot tell live from retired, which is precisely the failure
  §4.2's pointer-and-log exists to end. **The importer must map path → status explicitly,
  once, and record that it did.**

### 14.8 What this deliberately does not do

- **No auto-distill, no auto-promote.** Both require an explicit call (§14.5).
- **No transcript storage at all.** Not the bytes, not a row per file. A session index is
  an external service v4 queries (§14.6).
- **No eighth index over the session corpus.** Measured 2026-09-18: **7–8 distinct
  indexers** already exist over two corpora. `session-viewer` is the **canonical writer**
  of `~/.session-viewer/sessions.db` and `session-search` is a **reader-only** consumer of
  that same file — which is the pattern v4 follows. **v4 is a reader.** It stores
  no table of its own — it queries an external `SessionSource` (§14.6) and keeps exactly
  one column, `traces.session_id`, to tie a search back to the session it ran in.

  > One thing there **is** worth copying into v4's own schema: `vector_runs(id, model,
  > provider, endpoint, chunk_words, started_at, finished_at, events, vectors)`
  > (`session-viewer/schema.sql:128–141`), which records **which embedding provider saw the
  > data**. That is a stronger provenance claim than §4.5.3's per-row `embedder` string —
  > it answers *"did this text leave the machine, and to whom"*, which §4.5.3 cannot, and
  > §13 requires that question be answerable.
- **No backward inference of distillation from link position.** The vault does this today
  and it is unqueryable; v4 requires the explicit `distilled_to` pointer instead.

---

## 15. Honcho compatibility — the contract

The whole point of §3's shape is that a v4 bank can leave for Honcho, or arrive from it,
as a table dump. This section is what has to stay true for that to hold. **It is a
constraint on every future change to §3, and it is short on purpose.**

### 15.1 Three tiers

| Tier | Tables | Rule |
|---|---|---|
| **1 — core** | `workspaces` `peers` `sessions` `session_peers` `messages` | byte-compatible with `honcho/src/models.py`. Same names, same types, same uniqueness, same composite FKs. v4 may add **nullable** columns and nothing else |
| **2 — memory** | `memories` `vocabularies` `terms` `memory_terms` `supersede_log` | v4-only. Honcho never reads them. Dropping them leaves a valid Honcho database |
| **3 — observability** | `traces` `trace_hits` `connections` `mcp_calls` | v4-only, same rule as tier 2 |

**Export** = dump tier 1. **Import** = load tier 1. Neither touches tiers 2–3.

### 15.2 The invariants

1. **Never rename, re-type, or re-purpose a Honcho column.** Additive nullable columns only.
2. **Never name a v4 table after a Honcho table.** `documents` and `collections` are
   Honcho's (`models.py:379`, `:335`); v4's knowledge table is `memories` for exactly
   this reason.
3. **Every v4 table carries `workspace_name NOT NULL`** and reaches rooms and entities
   through composite FKs, the same way tier 1 does. No v4 table gets a private idea of
   the tenant.
4. **The FTS index is not part of the contract.** Honcho's `to_tsvector('english')` and
   v4's `tokenize='trigram'` sit over the same `content` column; each side rebuilds its
   own index after import.
5. **`h_metadata` is the extension point for tier 1.** Anything v4 wants on a peer or a
   room that Honcho has no column for goes in `h_metadata`, not in a new column — a new
   column is a new thing to reconcile; `h_metadata` is already JSON on both sides.
   *(Correction, 2026-09-27: `h_metadata` is only the SQLAlchemy attribute name in
   Honcho's `src/models.py`. Its SQL column is **`metadata`**, `jsonb NOT NULL DEFAULT
   '{}'`. The rule still stands for the REST path, where the field is `metadata`; a table
   dump must rename it.)*

> **Measured (2026-09-27, #8; verdict accepted by Nat 2026-09-28, NAT-DECISIONS D11a):**
> invariant 1 does **not** hold as a table dump. "Byte-compatible" in §3 and §15.1 is
> **false as stated**, and it is **true with conversions only for one bank imported into an
> empty stock Honcho**. Measured against a disposable Honcho v3.2.0 (`210b56cf`) on
> 127.0.0.1 by `bash app/just/honcho-live.sh`; white.local was not used.
>
> - **Conversions a dump needs:** rename `h_metadata` to `metadata` (a verbatim INSERT
>   fails: `column "h_metadata" of relation "workspaces" does not exist`); JSON text to
>   `jsonb`, where NULL becomes `{}`; naive `timestamp[us]` to `timestamptz` UTC;
>   `messages.token_count` narrowed from int64 to int32; `setval` on the messages
>   identity after load.
> - **Incompatible:** `messages.id` is one identity for Honcho's whole database but
>   per-bank in v4, so a second bank, or any Honcho that already holds messages, collides
>   on `pk_messages`. `workspaces.id` loads only if it is already nanoid21 (Honcho's
>   `length(id) = 21` CHECK would reject v4's own 18-character dev seed `ws_default_devseed`).
> - **Lost:** 10 v4 columns with no Honcho column: `workspaces.mission`,
>   `messages.role/in_reply_to/read/read_at`, the four `source_*` columns, and
>   `ingested_at`. The REST leg keeps `role`, `in_reply_to`, `read` and `read_at` through
>   the invariant 5 fold into `metadata._v4`; the table leg does not.
> - **What does hold:** the REST round trip (`TestLiveRoundTrip`, 1 OK) and, under the
>   conditions above, the table round trip (`TestLiveTableRoundTrip`, 1 OK: every row
>   reads back through REST and SQL with no value changed).
>
> True byte compatibility (global message ids, `metadata` as the stored name) was the
> alternative, and it was not chosen: it is a schema change of size L. Per-column evidence:
> `docs/overnight/HONCHO-TABLE-DIFF.md`; ruling: `docs/overnight/DECISIONS.md` R15.

### 15.3 Type mapping — PostgreSQL → libSQL

| Honcho (Postgres) | v4 (libSQL) | Note |
|---|---|---|
| `TEXT` | `TEXT` | — |
| `BigInteger` autoincrement | `INTEGER PRIMARY KEY AUTOINCREMENT` | `messages.id` |
| `TIMESTAMP(timezone=True)` | `INTEGER` epoch ms **or** ISO-8601 `TEXT` | pick one, state it in the migration, never mix |
| `JSONB` | `TEXT` holding JSON | `json_extract()` for queries |
| `text[]` (`documents.source_ids`) | `TEXT` JSON array | tier-2 only; not exported |
| `vector(1536)` | absent | embeddings are not in the contract; LanceDB or `F32_BLOB` per §4.4d |
| GIN `to_tsvector` | FTS5 `trigram` | §15.2 rule 4 |
| `CHECK (id ~ '^[A-Za-z0-9_-]+$')` | `CHECK (id GLOB '[A-Za-z0-9_-]*')` | regex → GLOB |

### 15.4 The alternatives considered, so nobody reopens them by accident

| Option | Tables | URLs | Why not |
|---|---|---|---|
| A — Honcho names everywhere | `workspaces` / `sessions` / `peers` | `/mcp/:workspace/:session` | loses "bank" — the word Nat actually uses and the one that names the product |
| **B — bank on the surface, Honcho underneath** ✅ | `workspaces` / `sessions` / `peers` | `/mcp/:bank/:workspace` | **chosen.** Keeps the vocabulary; costs one alias layer (§3.1.2) |
| C — v4 names in the database too | `banks` / `workspaces` / `entities` | `/mcp/:bank/:workspace` | export becomes a migration script instead of a dump, which is the whole benefit gone |

### 15.5 How to know it still holds

One test, run in CI: create a bank with two rooms, three entities and ten messages in v4;
dump tier 1; load it into a stock Honcho (its `docker compose` on `white.local:8000`
exists for this); call Honcho's `GET /v1/workspaces/{name}/sessions/{name}/messages` and
compare. If the shapes ever drift, this is the test that says so before a user does.

> **As built (2026-09-27, R15):** the test is `bash app/just/honcho-live.sh`. It stands up a
> disposable Honcho v3.2.0 on 127.0.0.1, runs the table leg (`TestLiveTableRoundTrip`) and the
> REST leg (`TestLiveRoundTrip`), and tears everything down. It does **not** use white.local,
> which is shared. It is not a CI step: it needs Docker, and the gate is the local CI mirror.
> What it measured is the verdict in §15.2.
