# arra-oracle-v4 — agent guide

> A memory bank you can leave. Honcho's schema, Hindsight's bank, v3's hard-won lessons.

**Read `SPEC.md` before changing anything.** It is 2,195 lines and it is the product right
now — there is **no code in this repo yet**, by decision, not by accident.

---

## What this is

A fresh-start successor to
[`arra-oracle-v3`](https://github.com/Soul-Brews-Studio/arra-oracle-v3). v3 keeps running
and is never deleted; v4 starts empty and earns its corpus. **No migration.**

The design is a deliberate merge of three sources:

| Source | What v4 takes | What it does not take |
|---|---|---|
| **[`plastic-labs/honcho`](https://github.com/plastic-labs/honcho)** | the **entire core schema**, byte-compatible — `workspaces`, `peers`, `sessions`, `session_peers`, `messages` — plus its *column idiom* (see below) | `collections`/`documents` (observer/observed theory-of-mind), its English-only `to_tsvector` FTS, PostgreSQL |
| **[`vectorize-io/hindsight`](https://github.com/vectorize-io/hindsight)** | the **bank** concept — an isolated brain, nothing shared across banks; `mission` as a descriptive field; auto-creation on first use | disposition traits (skepticism/literalism/empathy), consolidation, pgvector |
| **`arra-oracle-v3`** | typed memories, supersede-not-delete, bitemporality, the Drupal-shaped taxonomy, `trace_log` as a graph | its two parallel memory models, its `unicode61` FTS, its two tenant-isolation holes |

**One alias only.** `bank` = the `workspaces` table. In prose and URLs it is *bank*; in the
schema the column is always `workspace_name`. There is **no table named `banks`** and **no
column named `bank_id`**. Every other noun keeps Honcho's own word — a session is a session.

---

## The column idiom — follow it for every new table

Honcho's five tables all share one shape, and v4's own tables (tiers 2 and 3) were rewritten
to match. Any table you add must look like this too:

```
id                 TEXT PK nanoid(21)
name               TEXT                     -- UNIQUE (name, workspace_name)
workspace_name     TEXT NOT NULL            -- FK → workspaces.name
h_metadata         JSON                     -- user-visible
internal_metadata  JSON                     -- internal
created_at         TIMESTAMP
FK (x_name, workspace_name) → x (name, workspace_name)   -- composite, always
```

**The test for every field: is it a filter key or a display field?** Anything you `WHERE`
on stays a real column — libSQL and Lance both push predicates down on columns and neither
does on JSON. Anything you only render goes in `h_metadata`. This is why `memories` is 15
columns and not 21.

**Composite foreign keys are the isolation guarantee, not a convention.** A cross-bank
reference is a constraint violation at INSERT. This is the single most important structural
property in the schema — v3's equivalent was a runtime assertion and it had two live holes
that failed *open*. Never replace a composite FK with an application-level check.

---

## Decisions that are closed — do not re-litigate

| Decision | Outcome | Where |
|---|---|---|
| Schema base | Honcho's, byte-compatible | §3.2, §15 |
| Hierarchy | **Flat.** No nesting, no `parent_id`, no channel/thread split | §3.1.1 |
| The alias budget | **One** — `bank` = `workspaces` | §3.1 |
| Metadata store | libSQL/Turso + `tokenize='trigram'` FTS | §4.1 |
| Vectors | **LanceDB**, per-bank dataset, outside the libSQL file | §4.5 |
| Who owns Lance | **Python.** TS gets a read-only `VectorStore`; the boundary sits on §4.6's existing `sync_state` seam | §4.5.6 |
| Session mining | **External.** v4 is a client behind `SessionSource`, never the eighth writer over the `.jsonl` corpus | §14.6 |
| Schema source of truth | numbered `.sql` files. **Not an ORM** — Django 5.2's `ForeignKey` cannot target a composite PK, and `ForeignObject` emits no DB constraint | §4.1 |
| Licence | MIT | LICENSE |

**LanceDB-only was evaluated and rejected** (§4.4d): no joins, no constraints, no
multi-table atomicity, and `mergeInsert` is not an upsert under concurrency. libSQL is the
record of truth; **Lance is a derived index** and losing it entirely must be recoverable by
re-embedding. Do not reopen this without new measurements.

---

## Working rules

1. **Do not write implementation code** unless explicitly asked. The spec is the
   deliverable. Spike **S9** is the first thing that writes code and it needs a direct OK.
2. **Do not add a table to solve a problem a column solves.** Three separate times a
   proposed table collapsed to one or two nullable columns — life/event/chat needed two
   columns, chained distillation needed zero.
3. **Types are terms, not tables.** `life`, `event`, `note`, `decision` are rows in the
   `type` vocabulary (§3.3). Adding a kind of memory is a term insert, never a migration.
4. **Nothing is deleted.** Retirement is a status change everywhere except credentials and
   call-log rows, both named exceptions (§4.2.4).
5. **Cite the source when you claim something.** Honcho claims cite `models.py:NNN`; vault
   claims cite measured counts. The spec's credibility is that every number in it was
   measured.
6. **Version on every substantive edit**: CalVer `v{yy}.{m}.{d}-alpha.{HMM}`, Asia/Bangkok,
   where `HMM = hour*100 + minute`. Update the `**Version**:` and `**Date**:` lines together.
7. **Never `git push --force`, never `git commit --amend`, never push to `main`.** Feature
   branch + PR. Vault files under `ψ/` are shared state — **never `git add` them here.**

---

## Open decisions — ask, do not assume

1. **How should v4 forget?** v3 had `tier: warm|cold|archive`; v4 dropped it in the
   Honcho-idiom pass. Options are `tier` *replacing* `is_active`, a computed decay score
   (costs three new columns and writes on every read), or staying binary. A tier that
   nothing ever demotes is decoration — it only pays for itself with a scheduled sweep.
2. **`session-viewer` or `lanceglass` as the default `SessionSource`?** (§10 item 5)
3. Whether Feed / Memory-map enter v4 at all. Traces are in (§14); these are still absent.

---

## Map

| What | Where |
|---|---|
| The spec | `SPEC.md` — start at §3 (data model) and §4 (storage) |
| Honcho source of truth | `/opt/Code/github.com/plastic-labs/honcho/src/models.py` |
| v3, for comparison | `/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v3` |
| Lanceglass (prior art, running) | `/opt/Code/github.com/Soul-Brews-Studio/lanceglass` |
| Shared vault (symlink, not committed) | `ψ/` |
| Research: memory as religion | `ψ/writing/2026-09-18_memory-as-religion.md` |

*Written by an Oracle — AI speaking as itself (Rule 6).*
