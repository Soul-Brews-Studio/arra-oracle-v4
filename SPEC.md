# arra-oracle-v4 — Specification

**Version**: `v26.9.18-alpha.700`
**Status**: draft
**Date**: 2026-09-18 07:00 GMT+7
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
- **Not** multi-writer-at-scale in v1. Single writer per bank (§4.5).
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

### 3.1 Hierarchy

```
Workspace                    tenant / namespace / billing-and-access boundary
└── Bank                     one isolated memory store — its own LanceDB dataset
    └── Document             typed, superseded-not-deleted, bitemporal
        └── Chunk            embedded unit (vector row)
```

Two levels, deliberately:

- **Workspace** answers *"whose is this?"* — access control, quota, deletion blast
  radius. Maps to v3's existing `tenants` concept.
- **Bank** answers *"which brain is this?"* — one retrieval corpus. A workspace with
  banks `god-oracle` and `god-oracle-proof` keeps them as separate brains that share
  one owner.

> A single-bank workspace is a normal, expected shape. The second level costs nothing
> when unused: `workspace/default` is implicit if the caller names only a bank.

### 3.2 Entities

```ts
interface Workspace {
  id: string;             // nanoid
  slug: string;           // unique, URL-safe — appears in MCP endpoint paths
  name: string;
  created_at: number;
  metadata: Json;
}

interface Bank {
  id: string;             // nanoid
  workspace_id: string;   // FK → Workspace, NOT NULL
  slug: string;           // unique *within workspace*
  name: string;
  mission: string | null; // free text: what this bank is for. Descriptive, not behavioural.
  created_at: number;
  metadata: Json;
}

interface Document {
  id: string;
  bank_id: string;        // FK → Bank, NOT NULL  ← the isolation constraint

  // Free text, NOT an enum. A new type is a string a client picks,
  // never a migration someone has to run. Default 'note'. See §3.3.
  type: string;

  title: string;          // 1..200
  content: string;        // body, <= 100_000
  source_file: string | null;
  project: string | null;
  origin: string | null;

  // bitemporal
  created_at: number;     // when we learned it
  valid_time: number | null;  // when it was true in the world
  indexed_at: number;

  // supersede, never delete
  superseded_by: string | null;
  superseded_at: number | null;
  superseded_reason: string | null;

  // provenance — an answer must be traceable to a line range
  line_start: number | null;
  line_end: number | null;
  chunk_index: number | null;

  // published flag. Unpublishing is the reversible act;
  // supersede is the deliberate one. There is no DELETE (§4.2).
  status: 0 | 1;
}
```

Classification is **not** a column on the document — it is a taxonomy (§3.3).
`concepts: string[]` from v3 is replaced by term references.

`mission` is **descriptive metadata only** — it does not alter retrieval or ranking.
(Hindsight's disposition traits shape its `reflect` reasoning; v4 has no reflect, so
copying that would be cargo cult.)

### 3.3 Taxonomy — vocabularies, terms, tagging

Adopted wholesale from [`digger-node`](https://github.com/Soul-Brews-Studio/digger-node),
which reached this design by reading how Drupal actually works. v4 does not re-derive
it.

**Four nouns Drupal got right in 2004:**

| Noun | Is |
|---|---|
| `document` | one piece of content: title, body, datetime |
| `vocabulary` | a namespace for terms, **carrying a policy** (`kind`, below) |
| `term` | a label inside a vocabulary — nestable, ordered by weight |
| `document_terms` | the join — a document wears any number of terms |

```ts
interface Vocabulary {
  id: string;
  workspace_id: string;     // FK → Workspace — see "Scope" below
  name: string;             // machine name, lowercase slug, 1..64, unique per workspace
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

interface DocumentTerm {        // PRIMARY KEY (document_id, term_id)
  document_id: string;          // FK → Document, ON DELETE CASCADE
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

#### 3.3.3 Scope — vocabularies are per **workspace**, not per bank

A term is a *label*, not content. Scoping vocabularies to the workspace lets sibling
banks share one controlled vocabulary, which is what makes *"everything about X across
my banks"* answerable. Documents remain bank-isolated (§3.4); only the label namespace
is shared, and only within one workspace.

> Consequence to accept knowingly: two banks in one workspace can infer that a term
> exists from a vocabulary listing. Terms are owner-defined labels, so this is
> acceptable — but it is a deliberate seam in an otherwise fail-closed design, and
> §10 carries it as an open question.

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

### 3.4 Isolation — fail closed

v3 isolates vectors by **filesystem path** (`tenantDataPath()` folded into the LanceDB
directory, with the adapter itself tenant-blind). That is elegant and cheap, and it
**fails open**: one code path that builds a path without the helper silently shares a
dataset, and nothing errors.

v4 keeps path-derived storage but adds a backstop:

| Layer | Mechanism | Failure mode |
|---|---|---|
| Storage | one LanceDB dataset per bank, path derived from `workspace/bank` | fails open |
| Metadata | `bank_id` **NOT NULL** FK on every document row | fails closed |
| Vector rows | `bank_id` stored **in the Lance schema** and asserted on every read | fails closed |
| Access | `resolveBank(workspaceSlug, bankSlug)` is the **only** way to obtain a handle | single choke point |

Storing `bank_id` redundantly in the vector rows is intentional duplication: it makes a
cross-bank leak an assertion failure rather than a wrong answer.

---

## 4. Storage

### 4.1 Two stores, one owner

| Store | Holds | Engine |
|---|---|---|
| Metadata + FTS | workspaces, banks, documents, supersede chain, entity links, **full-text index** | **Turso / libSQL** |
| Vectors + chunks | embedded chunks, `bank_id`, doc pointer | **LanceDB** |

**Turso (libSQL), not stock SQLite.** libSQL is SQLite-compatible, so Drizzle and the
whole SQLite mental model carry over — but **embedded replicas** give the local-first →
cloud seam directly: a local file for reads, optionally syncing to a remote. That
removes the `local | cloud` fork from the metadata half entirely (§4.3 then only
governs vector storage).

#### 4.1.1 Why FTS lives in libSQL and vectors do not

libSQL *can* store vectors natively (`F32_BLOB` + `libsql_vector_idx`, DiskANN). v4
still keeps vectors in LanceDB, for measured reasons — see §4.4.

#### 4.1.2 FTS tokenizer — `trigram`, non-negotiable

`tokenize='trigram'`. **Never `unicode61`.**

Measured on this fleet's corpus: Thai combining marks are token *breaks* under
`unicode61` (the diacritic exception covers Latin only), so `ความ` returns **5 hits
where trigram returns 435**. Thai is effectively invisible.

> **arra-oracle-v3 shipped `unicode61`-only and is structurally unable to find Thai
> inside words.** This is a known inherited defect that v4 exists to not repeat.

Costs of trigram, accepted knowingly: ~1.8–3× index size, cannot match a needle under 3
characters (fall back to `LIKE` **and say so in the response**), and must never be
handed a wildcard. Every FTS token is quoted on the way in — an unquoted hyphen parses
as FTS5's `NOT` and returns silence.

> This finding has now been independently measured **four times** across this fleet. It
> is the single most re-derived result we have, which is why it ships as a hard default
> rather than being rediscovered a fifth time.

#### 4.1.3 External-content FTS needs its triggers or it lies

The FTS table is `content='documents'` (external-content) so the text is not stored
twice. External-content FTS5 **does not follow its source table on its own**. Without
all three triggers — `AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE` — the index drifts
silently, which is worse than having no index: searches then return confidently wrong
results.

The `DELETE` and `UPDATE` triggers must emit FTS5 `'delete'` rows for the *old* values.
A bare `UPDATE` leaves the previous text matchable forever.

### 4.2 Supersede as a constraint

There is no `DELETE` in the write path. `supersede(doc_id, by, reason)` writes
`superseded_by` / `superseded_at` / `superseded_reason`. Default queries filter
`superseded_by IS NULL`; history is always reachable with an explicit flag.

Bank deletion is likewise a status change, not a drop. Physical removal is an
out-of-band operator action, never an API call.

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

**If v4 ever does put vectors in libSQL**, these are mandatory, not optional:
- check `PRAGMA freelist_count` against `page_count` before believing a file is "too big"
- set `auto_vacuum=INCREMENTAL` *before* the first full VACUUM
- VACUUM **through `@libsql/client`**, never the stock `sqlite3` CLI — VACUUM replays the
  schema and stock SQLite dies with `no such function: libsql_vector_idx`
- never `DROP`+`CREATE` an ANN index on a schedule

### 4.5 Concurrency

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
│   MCP endpoint  /mcp/:workspace/:bank        │
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
- **Per-bank endpoints**: `/mcp/:workspace/:bank`. A connector is scoped to one bank at
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
| `supersede` | mark a document superseded by another, with a reason |
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
| **S2** | Concurrent-writer safety on object storage — is an external commit lock required? | §4.5 single-writer assumption is a workaround, not a decision | two writers against one bank on R2, observed conflict behaviour documented |
| **S3** | Does claude.ai's connector accept a **path-scoped** resource (`/mcp/ws/bank`)? | §6.1 per-bank endpoints depend on RFC 9728 `resource` exact-match with a path | a real claude.ai connector added and approved against a path-scoped URL |
| **S4** | Embedder choice for local-first (no API key) vs cloud | affects bank portability — a bank re-embedded with a different model is a different corpus | embedder identity recorded per bank, mismatch detected on read |
| **S5** | Turso **embedded replica** behaviour under an offline local-first start — does it degrade cleanly with no sync URL? | §4.1/§4.3 assume "sync is a config value"; if the client demands reachability, local-first breaks | server starts, writes, and recalls with `ORACLE_DB_SYNC_URL` unset and the network down |
| **S6** | Does `tokenize='trigram'` FTS behave identically on libSQL as on stock SQLite FTS5? | §4.1.2 is load-bearing for Thai; a libSQL divergence would be silent | `ความ` returns the trigram-count order of magnitude (~435), not the `unicode61` one (~5) |

Nothing in §4.1, §4.3, §4.5, or §6.1 should be treated as settled until its spike
closes. **S6 is the highest-value cheap one** — it is a single query and it protects the
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

## 12. Entities, threads and channels

Ported from v3's forum (`forum_threads` / `forum_messages`) and fleet log
(`fleet_messages`), and joined to the fleet's existing presence transport.

### 12.1 Scope — v1 is threads and chat, delivery comes later

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

```ts
interface Entity {
  id: string;
  workspace_id: string;        // FK → Workspace. The address book is workspace-scoped.
  slug: string;                // unique per workspace — matches OC_NAME / the MQTT <name>
  kind: 'oracle' | 'human' | 'agent' | 'service';
  display_name: string;
  bank_id: string | null;      // an oracle's own bank, if it has one
  repo_url: string | null;     // github.com/... — an oracle is usually a repo
  mcp_url: string | null;      // if this entity exposes its own MCP endpoint
  channel_name: string | null; // its MQTT <name>, when it differs from slug
  metadata: Json;
  created_at: string;
  last_seen_at: string | null; // v1: last write by this entity. Later: observed presence.
                               // Never asserted by v4 (§12.5).
}
```

**Registration is a write to v4; presence, when it exists, is read from the broker.** Keeping those
separate is deliberate: a registry that also claimed liveness would go stale silently
the moment a session died without deregistering — which is precisely the failure LWT
exists to prevent.

`slug` deliberately mirrors `oracle-channel`'s identity rule (default = basename of the
session's working directory, override `OC_NAME`) so one name addresses an entity in
both systems. v4 **must not** invent a second naming scheme.

> Identity collision is a real, observed failure: two live sessions sharing a name steal
> the broker connection from each other. v4 makes `(workspace_id, slug)` unique, so it
> can at least *name* the collision rather than compound it.

### 12.3 Threads and messages

```ts
interface Thread {
  id: string;
  workspace_id: string;        // conversations are cross-bank by nature
  bank_id: string | null;      // optional: pin a thread to one bank's subject matter
  title: string;
  status: 'active' | 'resolved' | 'archived';
  created_by: string;          // FK → Entity
  room: string | null;         // maps to the MQTT <room> segment
  issue_url: string | null;    // v3 carried these and they earned their place
  issue_number: number | null;
  project: string | null;
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  thread_id: string;           // FK → Thread, ON DELETE CASCADE
  author_id: string;           // FK → Entity  ← never a free-text name
  role: string;                // free text, like `type` (§3.2): 'question','answer','note',…
  content: string;
  in_reply_to: string | null;  // FK → Message — threads nest, like terms do
  created_at: string;
  delivered: DeliveryRef[];    // empty in v1 — the seam for §12.5
}
```

Three deliberate choices:

1. **`author_id` is a foreign key, not a string.** v3's `forum_messages.author` and
   `fleet_messages.from_id` are free text, so "who said this" cannot be answered by a
   join — only by string-matching names that drift. Entities exist to fix that.
2. **Threads and messages wear terms** (§3.3) like documents do. A conversation is
   classifiable content; `status:resolved` is a controlled term, not a second enum
   invented here.
3. **Messages are FTS-indexed with `trigram`** (§4.1.2). A fleet conversation in Thai is
   exactly the case `unicode61` loses.

#### 12.3.1 Promotion — the point of storing chat next to memory

A message worth keeping becomes a document:

```
promote(message_id, bank_id, type) → Document
```

The document records the message as its `origin`, so provenance runs
`document → message → thread → entity`. This is the whole reason a memory server hosts
conversations at all: **the interesting things get said in chat, and today they die
there.** Promotion is explicit and human/agent-triggered — v4 never auto-promotes,
because a store that decides for itself what was important stops being a mirror.

### 12.4 "What's new for me" — the v1 notification story

No push, no lying about push. Each entity carries a read cursor per thread:

```ts
interface ReadCursor {                 // PRIMARY KEY (entity_id, thread_id)
  entity_id: string;
  thread_id: string;
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
  entity_id: string;
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
| Hindsight bank fields (`bank_id`, `mission`, disposition) | `hindsight-clients/python/hindsight_client_api/models/bank_profile_response.py`, `disposition_traits.py` |
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
