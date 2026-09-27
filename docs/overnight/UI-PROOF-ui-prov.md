# UI proof: ui-prov (#33 design revision 2, #30 freshness consumer)

Slice `v4/on-ui-prov`, based on `origin/main` d949290. It covers the part of the #33 revision-2
criterion that the acceptor (TASK-8) judged PARTIAL: *"Render freshness, provenance,
direct/reverse evidence and distinct author/observer/subject; missing summary and unresolved
evidence remain visible rather than fabricated."* Direct and reverse evidence and the unresolved
labels already passed; this slice does not touch them.

## What the Knowledge node view now shows for the head revision

| AC part | Source field(s) | Rendered as |
|---|---|---|
| distinct roles | `author_peer_name`, `observer_peer_name`, `subject_peer_name` | three labelled rows (`data-role=author/observer/subject`). An absent role reads `no <role> recorded`. No `by` row exists. |
| provenance | `id`, `revision_no`, `base_revision_id`, `session_name`, `operation_id`, `created_at`, `change_reason`, `valid_from`/`valid_to`, `content_digest` (full), `canonical_version`, `schema_version` | `data-prov=*` rows. An absent value is muted and italic, with its own marker text. |
| missing summary | none. The 26-field revision row has no summary column, and DESIGN keeps a saved summary as its own node. | `data-prov=summary` always reads `no summary`. Nothing is taken from the body. |
| freshness | `getSearchFreshness` (workspace-wide) plus `listSearchChunks(head revision, chunker/v1, active profile)` | `data-freshness-state` = `unindexed` / `pending` / `failed` / `indexed` / `unknown` / `loading`. Workspace figures are labelled as the workspace's. |

`getSearchFreshness` takes only `workspace_name`. It cannot say anything about one node. So the
node's state comes from its head revision's own chunks under the active profile, and that
profile is the one `getSearchFreshness` names. The UI keeps the workspace counts separate and
labels them as workspace counts.

## Tests (failing first)

- `app/ui/v2/src/state/revisionProvenance.test.ts`: the role and provenance mappers.
- `app/ui/v2/src/state/searchFreshnessView.test.ts`: every state. A failed or malformed read is
  `unknown`. A null text index is unknown, not zero.
- `app/ui/v2/src/components/provenancePanels.test.ts`: `renderToStaticMarkup` of NodeHead and
  SearchFreshnessPanel, one test per state.
- Red before the fix:
  - With no implementation, all three files failed on `Cannot find module`.
  - With the old NodeHead, 4 render tests failed: `Expected: "nat" / Received: null` (author),
    `no observer recorded`, `s1` (session) and `no summary`.
- Mutants, each shown red and then reverted:
  - The observer falls back to the author.
  - An error read reads as `indexed`.
  - The summary is the body's first line.
  - Together the mutants turned **8 tests red**.
- After the fix: `bun test src` in `app/ui/v2` gave 328 pass / 0 fail, and
  `tsc -p app/ui/v2/tsconfig.json` was clean.

## Live proof: DOM reads on a fresh gated stack

The stack came from `app/just/demo/stack.sh` `demo_stack_up`:
- a mktemp root holding target19 + legacy15 datasets and a dev policy;
- the server started through the writer gate on a free port, serving this worktree's rebuilt
  bundle;
- as the embedder, a local Bun stub of Ollama: `/api/tags` answers with a 64-hex digest, and
  `/api/embed` returns 384 floats, or HTTP 500 while a flag file exists.

The driver made raw HTTP calls to `/api/knowledge/default/*`:
- `registerPeer` for nat, neo and boy, then `registerSession s-prov` and
  `seedReservedVocabularies`;
- `publishRevision` for each node, then `indexRevisionChunks` and `embedPendingChunks`.

Browser: ego-browser (Ego Lite) task space 276. Each read navigates to
`/v2/index.html#/knowledge?node=<id>` and reads the DOM through `page.evaluate`.
**No screenshots were taken.** Screenshot capture times out in Ego Lite on this machine
(TASK-8 recorded the same thing), so everything below is DOM evidence, not pixels.

| # | Node / step | DOM read |
|---|---|---|
| 1 | "three distinct roles": author nat, observer neo, subject boy, session s-prov. Indexed, not embedded. | roles `{author:"nat", observer:"neo", subject:"boy"}`. `summary:"no summary"`. `base:"none — first revision of this node"`. `session:"s-prov"`. `reason:"no change reason recorded"`. `validity:"no validity window recorded"`. Full 64-hex digest. `freshness_state:"pending"`, label `pending — not embedded yet`, `this revision: 0 ready · 1 pending · 0 failed`. Workspace: `0 ready · 2 pending · 0 failed`, profile `ollama/all-minilm/384/none`, `last embed attempt: never attempted`, model digest `not pinned yet · not measured by this server process`. `by_label_present:false`. |
| 2 | "missing observer": author nat, no observer, subject boy, no session. Indexed, not embedded. | roles `{author:"nat", observer:"no observer recorded", subject:"boy"}`. `session:"no session recorded"`. `summary:"no summary"`. `freshness_state:"pending"`. |
| 3 | "never indexed": no roles, `indexRevisionChunks` never called | roles `no author recorded` / `no observer recorded` / `no subject recorded`. `freshness_state:"unindexed"`, meaning `This revision has no search chunks under the active profile yet, so neither keyword nor semantic search can find it.` |
| 4 | Node 1 after `embedPendingChunks` (`{attempted:2, embedded:2, blocked:null}`) and the in-view **re-check** button | `freshness_state:"indexed"`, `All 1 chunks have a vector under the active profile; keyword and semantic search can both find this revision.` Workspace: `2 ready · 0 pending · 0 failed`. Model digest `pinned deadbeef… · last measured deadbeef…`. Text index (workspace) `0 rows indexed · 2 not yet`, as the server reported it after the vector write. |
| 5 | "embed fails": author neo, observer nat, no subject. Indexed, then embedded while the stub answered 500 (`{attempted:1, failed:1}`). | roles `{author:"neo", observer:"nat", subject:"no subject recorded"}`. The roles are reversed from node 1 and still shown distinctly. `freshness_state:"failed"`, label `failed — embedding failed`, `1 of 1 chunks failed to embed; semantic search cannot see them until a retry succeeds. The content itself is saved.` `this revision: 0 ready · 0 pending · 1 failed (embedder_bad_response)`. |
| 6 | Server stopped (SIGTERM, `/health` unreachable), then **re-check** on node 5 | Before: `failed`. After: `freshness_state:"unknown"`, label `unknown`, `Search freshness could not be read (freshness: Failed to fetch). This is not a claim that it is fresh.` 0 workspace rows. |

A note on wording. The brief paired "pending (before indexRevisionChunks)" with "indexed
(after)". The server's own states are different:
- before `indexRevisionChunks` there are no chunks, which is `unindexed` (row 3);
- after it, the chunks exist but have no vectors, which is `pending` (rows 1 and 2);
- after `embedPendingChunks` they are `indexed` (row 4), or `failed` (row 5).

The UI follows the server, not the brief's wording.

## Teardown

- The server was stopped with SIGTERM before row 6, and `/health` was unreachable afterwards.
- The stub embedder was killed.
- The mktemp root was removed (`rm -rf`, and a later `ls` confirmed it was gone).
- `localStorage` and `sessionStorage` for `http://127.0.0.1:65207` were cleared with
  `Storage.clearDataForOrigin`:
  - keys before: `arra-ui-v2-nodes:default:default`, `arra-ui-v2-token` and
    `arra-ui-v2-roster:default`;
  - keys after: none.
- The task space was closed with `finish({ keep: [] })`.

## Known limits

- **Summary.** The UI can never show a summary as present, because no summary field exists on
  the revision. If a summary field or summary node link is added to the contract later, the
  `summary` row in `revisionProvenance` is where it will be read.
- **Scope of the freshness figures.** Only the node's chunk counts are per node. Everything that
  comes from `getSearchFreshness` is workspace-wide, and the text-index figures are null
  whenever the shared table holds rows from other workspaces (search-chunk-v1 §B).
- **No push updates.** Freshness does not update on its own. Indexing and embedding run outside
  the view, so the **re-check** button re-reads them.

## Fix round (2026-09-27): search findability follows recall eligibility

**What the verifier refuted.** Every chunk `ready` rendered as *"keyword and semantic search can
both find this revision"*. That was false for a retired head and for an `is_active: false` head:
the verifier's gated fixture returned `{"hits":[]}` from both searches. Search drops any node
that is not recall-eligible (`service.currentEligibleChunks.ts` step 3, which calls
`evaluateNodeEligibility`: retired, superseded, inactive, not yet valid, expired).
`getAcceptedHead` still returns those heads, so the panel still shows for them.

**The fix (UI only; `app/server/src` and `app/docs/contracts` untouched).**
- The panel now states two separate facts.
  - The **chunk state** (`data-freshness-state`) comes from `listSearchChunks` and makes no
    findability claim.
  - The **search line** (`data-freshness="search"`, `data-search-state`) is decided by
    `getRecallEligibility` for the node on screen. Its states:
    - `searchable`: eligible and chunked.
    - `not_searchable`: eligible, but no chunks yet.
    - `excluded`: not eligible. The line names the server's reasons.
    - `unknown`: the eligibility read failed, or came back in a shape this UI does not know.
      This state never makes a findability claim.
- The `failed` text now reads `attempts` against the 5-attempt cap (search-chunk-v1.md). A row
  at the cap says *"will not retry"*, not *"until a retry succeeds"*. A mixed set of failed and
  pending chunks says both.
- The `indexed` text states that chunk rows carry no expected count, so a chunk row that was
  never written cannot be seen.

**Tests (red first, in `.tmp/ui-prov-fix/red.txt`).** Before the fix: 23 fail / 23 pass across
the new and updated files, and both race tests red. After the fix: 46/46, and `bun test src` in
`app/ui/v2` gives 352 pass / 0 fail.

Mutants, all in `.tmp/ui-prov-fix/mutants.txt`. Each one fails at least one test:

| Mutant | Tests that fail |
|---|---|
| `g === gen.current` guard removed | the race test |
| `KnowledgeView.tsx` reverted to d949290 | the wiring test |
| pending block moved ahead of failed | the mixed-set test |
| `eligible: false` ignored | 9 tests |
| attempt cap ignored | the cap test |

### Live DOM reads on a fresh gated stack (ego-browser task space 286)

The stack was the same as above: `demo_stack_up`, the stub Ollama, and raw HTTP seeding.
- Three nodes were published, all containing `zebrafish`. One was published with
  `is_active: false`.
- All three were indexed and embedded (`{attempted:3, embedded:3}`), and then one was retired.
- The server's own answers:
  - `getRecallEligibility`: eligible `true []`, retired `false ["retired"]`, inactive
    `false ["inactive"]`.
  - `searchKnowledgeKeyword("zebrafish")`: hits = `[eligible node]` only.
- A fourth node was indexed and then embedded six times while the stub returned 500. The chunk
  ended as `["failed","5","embedder_bad_response"]`, and the sixth run `attempted:0`.

**No screenshots.** Ego Lite screenshot capture times out on this machine. Everything below is
DOM evidence only.

| Node | chunk state / label | `data-search-state` | search line (verbatim) |
|---|---|---|---|
| eligible | `indexed` / `indexed` | `searchable` | Recall-eligible: keyword and semantic search can both return this revision. |
| retired | `indexed` / `indexed` | `excluded` | Search does not return this node: it is retired. Keyword and semantic search both filter it out, whatever its chunks say. |
| inactive | `indexed` / `indexed` | `excluded` | Search does not return this node: it is inactive (its head revision has is_active false). Keyword and semantic search both filter it out, whatever its chunks say. |
| capped | `failed` / `failed — embedding failed` | `searchable` | Recall-eligible: keyword search can return it from its chunk text; semantic search skips 1 chunk without a vector. |

The capped node's meaning line read: *"1 of 1 chunks failed to embed; semantic search cannot
use them. 1 reached the 5-attempt cap, so embedPendingChunks will not retry it; it stays failed.
The content itself is saved."*

For every indexed node the meaning line read: *"All 1 chunks have a vector under the active
profile. The rows carry no expected chunk count, so a chunk row that was never written would
not show here."*

The roles on these nodes were read as well:
- eligible: nat / neo / boy;
- retired: nat / `no observer recorded` / boy;
- inactive: neo / nat / `no subject recorded`.

No `by` label appeared on any node.

**Teardown.**
- `localStorage` for `http://127.0.0.1:62722` was cleared with `Storage.clearDataForOrigin`:
  keys before were `arra-ui-v2-nodes:default:default`, `arra-ui-v2-token` and
  `arra-ui-v2-roster:default`; keys after: none.
- Task space 286 was closed with `finish({ keep: [] })`.
- The server (SIGTERM) and the stub were stopped; `/health` was unreachable afterwards.
- The mktemp root was removed, and `ls` confirmed it was gone. No leftover processes remained.

Not covered live: a `superseded` head and a head outside its validity window. The pure view
tests pin both (`searchFreshnessView.eligibility.test.ts`), and they take the same `excluded`
path as retired and inactive.
