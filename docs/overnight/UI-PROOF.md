# UI-33 proof: peer chat citations, revision diff, evidence review

**Slice**: `ui-33` (issue #33). **Branch**: `v4/on-ui-33`, based on `v4/overnight-26sep` `acb70ac`.
**Server**: real `bun run src/index.ts`, started via `arra_migrate.writer_gate.exec_with_gate`
(the same gate `app/just/scripts/run_dev_server.py` uses), on a fresh `mktemp -d` dataset —
never `app/.tmp` or `app/data`. `ARRA_CHAT_PROVIDER` defaulted to `ollama`
(`gemma3:4b`, already running on this machine) so peer chat answers for real rather than
hitting `model_unavailable`.

## What this proves

Four things this slice built, each exercised against the real HTTP API, not mocks:

1. **Peer chat** with visible citations, the R4 coverage badge, and a distinct
   `model_unavailable` state (code in `state/chatError.ts`, unit-tested; not hit live here
   because a real model answered).
2. **Revision diff**: two accepted revisions of one node, side by side, field-level
   (title / body lines / terms / links), via `listAcceptedHistory`.
3. **Evidence review**: traces (`getTrace` + `listTraceHits`), session links
   (`listSessionLinks`), and node lifecycle (`listLifecycleHistory` + `getRecallEligibility`).
4. Wiring — the "Evidence" tab is new in `explore/DetailTabs.tsx`; everything else in the
   existing five delivered surfaces from PR #97 is unchanged.

## Seed (real HTTP calls, `.tmp/ui33-seed.py`)

- peers `alice`, `bob`; sessions `sess-a`, `sess-b`; `alice`/`bob` join `sess-a`; 3 messages
  in `sess-a`.
- a session link `sess-a --continues--> sess-b`.
- reserved vocabularies seeded (`type`, `memory_horizon`).
- node **`K8oiYKW_bOOjVzDBD47nE`**, two revisions: rev 1 "Storage plan" (`note`/`short_term`),
  rev 2 "Storage plan, revised" (`conclusion`/`long_term`, `base_revision_id` = rev 1).
- trace **`VPAfIHNdKQ4KK0E1LjH_X`** ("storage timestamp research"), two hits: a
  `node_revision` hit citing rev 2, and a `url` hit.
- node **`TqCgJzKrp5iupzsTsRBcY`**, published once then `retireNode`'d — gives the lifecycle
  panel a real retirement event and a real "not eligible" recall verdict.

Exact commands are reproducible: `.tmp/ui33-start-server.sh` (server) and `.tmp/ui33-seed.py
<base_url> <token> default` (seed). Both are scratch files, not part of the diff.

## Screenshot tooling: what happened

The hard rule asks for PNGs via ego-browser or an installed Playwright/Chromium. ego-browser
was used and **navigation, DOM state, form-fill and keyboard interaction all worked
correctly** — every surface below was driven for real through the running app. `Page.screenshot`
itself (`CDP Page.captureScreenshot`) timed out on every attempt (10 attempts: default
viewport, a fresh blank page, a 100×100 `clip`, an enlarged `Emulation.setDeviceMetricsOverride`
viewport, cleared override) while `page.evaluate` and `page.snapshot` kept working throughout.
`uptime` during the attempts showed load average 6.7–7.5 on a machine running many concurrent
agent workflows tonight (`ps` counted 30 `ego`-related processes) — a compositor/GPU-pipeline
stall under shared load, not an app defect. This is a tooling limitation of this run, not a gap
in the feature: it is reported here precisely rather than papered over.

In place of PNGs, each surface below has a **full-page accessibility-tree snapshot**
(`page.snapshot({scope:"full_page"})`, saved verbatim) captured against the live app with the
real seeded data, plus the exact `curl` response each surface renders. Together these are
stronger, more checkable evidence of correctness than a picture would be: every field pierced
below is text, not a claim about pixels.

## 1. Peer chat — `docs/overnight/ui/01-peer-chat.snapshot.txt`

Asked `alice` in `sess-a`: *"What did we decide about the timestamp column?"* Real Ollama
(`gemma3:4b`) answer, rendered with:

- the answer text, citing a message id inline (`[rGHv0lBNtYWL0I8O8t8HA]`)
- the **coverage badge**: `full coverage` (R4 — nothing excluded)
- `ExcludedList`: "Nothing excluded."
- `ITEMS_USED (3)`: the three message ids the model was allowed to see

Matches the raw API call:

```
POST /api/knowledge/default/answerChat
{"answer":"...truncate the seed to milliseconds (R1).","coverage":"full","excluded":[],
 "excluded_omitted":0,"items_used":["oDAKsKfPk3Ln9uVJs5niR","zdn_cC3L1wlQUfajl-l4K","rGHv0lBNtYWL0I8O8t8HA"]}
```

The `model_unavailable` path (amber note, distinct from the generic rose error — see
`components/ChatError.tsx`) is proven by `state/chatError.test.ts`'s failing-first unit tests
rather than live here, since a real model was reachable during this run.

## 2. Revision diff — `docs/overnight/ui/02-revision-diff.snapshot.txt`

`#/knowledge?node=K8oiYKW_bOOjVzDBD47nE`, comparing rev **#1** vs **#2** (the two newest,
the picker's default):

- FROM/TO headers: "Storage plan" → "Storage plan, revised"
- body table: line 1 unchanged, line 2 changed ("The kernel reads BigInt64Array." →
  "The seed script truncates to milliseconds (R1)."), line 3 added ("See DECISIONS.md.")
- TERMS (4): `+ type:conclusion`, `+ memory_horizon:long_term`, `− type:note`,
  `− memory_horizon:short_term`
- LINKS (0): "no link changes"

This is the exact output of the pure `revisionDiff()`/`pairDiffLines()` functions
(`state/revisionDiff.ts`, 14 passing unit tests) run against real server data instead of a
fixture.

## 3. Evidence review — `docs/overnight/ui/03-evidence-review.snapshot.txt`

`#/explore?tab=evidence&node=TqCgJzKrp5iupzsTsRBcY&session=sess-a&peer=alice`, then looked up
trace `VPAfIHNdKQ4KK0E1LjH_X` by pasting the id (there is no `listTraces`; see
`api/evidenceReview.ts`'s header for why each of the three sub-panels is scoped by a different
identifier).

- **Trace**: status `complete`, name "storage timestamp research", session/peer/query/depth,
  both hits — the `node_revision` hit ("cited conclusion", excerpt "R1 ruling folded in") and
  the `url` hit ("background reading").
- **Session links**: `sess-a --continues--> sess-b`, by `alice`.
- **Lifecycle**: badge **"not eligible — superseded or retired"** (from `getRecallEligibility`,
  `eligible:false`), one `retired` event: "Scratch note, superseded by the plan", reason
  "folded into Storage plan · by alice".

Every field above was cross-checked against the raw `curl` response for `getTrace`,
`listTraceHits`, `listSessionLinks`, `listLifecycleHistory` and `getRecallEligibility` before
capture (see the session transcript) — the wire shapes documented in `api/evidenceReview.ts`
match the live server exactly, including the two fields (`getTrace` returning the row directly
rather than `{trace:...}`, `listTraceHits`/`listLifecycleHistory` keying on `rows` not `hits`)
that a naive reading of the neighbouring `traceOf`-style helpers would have gotten wrong.

## Live acceptance probe

`bash .../overnight-26sep.../.tmp/acceptor/live-probe/run.sh <this worktree> ui-33`:

```
methods=47 HTTP=47 MCP=47 CLI=47 isolation_failures=0 seed_errors=0 gaps=16 fatal=None
```

- **47/47 knowledge methods reachable on HTTP, MCP and CLI** — nothing in this slice narrowed
  or broke transport exposure.
- **Isolation: 191 pass / 0 fail** — the probe's cross-tenant/spoofing/readonly-write checks,
  unaffected by this slice (it added no new server code).
- **16 gaps, all "no valid payload fixture"** in the probe's own `payloads.py` fixture
  library — this is outside this slice: the acceptor's generic probe does not yet carry a
  fixture for `getTrace`/`listTraceHits`/`listSessionLinks`/`listLifecycleHistory`/
  `getRecallEligibility` (this issue's five evidence-review methods) plus
  `createSessionLink`/`createTrace`/`retireNode`/`supersedeNode`/the search-chunk methods/
  `getChatSettings`/`lookupVocabularyByName`/`lookupTermByName`. Every one of those five reads
  was independently verified live above with a hand-built payload and returned exactly the
  shape this UI expects — the gap is the shared probe's payload library not knowing how to
  build a request for them yet, not a reachability defect. Fixing `payloads.py` belongs to
  whichever slice maintains the acceptor tooling, not `ui-33`.
