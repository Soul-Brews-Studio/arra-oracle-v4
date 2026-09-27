# UI-33 proof: peer chat citations, field-level revision diff, evidence review, lifecycle writes

**Slice**: `ui-33` (issue #33). **Branch**: `v4/on-ui-33`, based on `v4/overnight-26sep` `acb70ac`.
**This is the FIX ROUND.** An independent Opus verifier reviewed the first pass (commit
`3ed0875`) and REFUTED it on three blocking findings plus several nonblocking ones. This
document is the fix round's proof, run fresh against a NEW server/dataset on top of the fixed
code. It replaces the previous version of this file rather than appending to it, because two of
the fixed defects (the field-level diff, the diff-size guard) make the previous screenshots'
underlying claims wrong, not merely incomplete.

**Server**: real `bun run src/index.ts`, started via `arra_migrate.writer_gate.exec_with_gate`
(the same gate `app/just/scripts/run_dev_server.py` uses), on a fresh `mktemp -d` dataset —
never `app/.tmp` or `app/data`. `ARRA_CHAT_PROVIDER=ollama` (`gemma3:4b`, already running on
this machine) so peer chat answers for real.

## Fix round 2 (commits `b4e68b5`..HEAD): diff pairing and AC3 evidence labels

A second independent verifier REFUTED fix round 1 on two blocking findings. Both are fixed
here, failing-first, and shown live. This section is newer than everything below it; where the
two disagree (the "no PNG" notes, snapshots 04/05), this section is the current state.

### Blocking 1: side-by-side diff mispaired consecutive edits

`pairDiffLines` only looked at the NEXT op. An edit of k >= 2 consecutive lines produced k-1
removed rows, one false "changed" row (the LAST old line beside the FIRST new line), then k-1
added rows. `keep/alpha/beta/end -> keep/ALPHA/BETA/end` read "beta became ALPHA".

**Fix** (`state/pairDiffLines.ts`, now its own file): collect each hunk (a maximal run of
non-equal ops), then pair the i-th removed line with the i-th added line. That gives min(k,m)
changed rows, and the rest are removed or added rows. Each column keeps its own order.

Live, through the UI's own `listAcceptedHistory` → `revisionDiff` → `pairDiffLines`
(`.tmp/ui33-round2-live-labels.ts`, a fresh dataset):

```
equal: keep | keep
changed: alpha | ALPHA
changed: beta | BETA
equal: end | end
changed: บรรทัดหนึ่ง | บรรทัดหนึ่ง (แก้)
removed: บรรทัดสอง | —
removed: บรรทัดสาม | —
equal: tail | tail
added: — | extra line
```

Picture: `ui/11-revision-diff-pairing.png`.

### Blocking 2: #33 AC3, stale or unavailable evidence must be visibly labelled

`AssociationPanel` and `DependentsPanel` rendered no `capture_status` and no target state. An
`unresolved` code citation looked the same as a `captured` one.

**Fix**: every evidence row now carries badges, and each one comes from a field the API
actually returns:

| label | source |
|---|---|
| `captured` / `locator only` / `unresolved` | the link row's `capture_status` (a retained claim from citation time, per association-evidence-v1 §3; the detail text says "when cited") |
| `stale: not head` (names the current head) | `getRevisionAssociations(node, EXACT cited rev)` → `is_snapshot_head: false`, `snapshot_head_revision_id` |
| `target unavailable` | the same call answered `null`: no such revision on accepted history |
| `target superseded/retired` | `getRecallEligibility(cited node)` → `eligible: false` |
| `citing node superseded/retired` / `citing node current` | `getRecallEligibility(citing node)`. Current-mode `scanDependents` does not filter lifecycle (§4) |
| `historical citing revision` | occurrence `is_snapshot_head: false` |
| `checking…` / `… status unknown` / `… not checked` | lookup still in flight / failed (with its error) / past the 32-target cap |

Live checks are made only for `node_revision` targets. A url, code or issue target sits outside
this dataset, so it gets only its capture claim. A `warn`/`bad` label prints its detail as
visible text, not only as a tooltip.

Live, through the UI's own modules (`getRevisionAssociations` → `resolveCitedRevisions` →
`directEvidenceLabels`; `scanDependents` → `resolveCitingNodes` → `reverseEvidenceLabels`):

```
DIRECT  url           locator_only  -> warn:locator only
        code          unresolved    -> bad:unresolved
        node_revision captured      -> ok:captured, warn:stale: not head, warn:target superseded/retired
REVERSE D (retired)   locator_only  -> warn:locator only, warn:citing node superseded/retired
        E (current)   captured      -> ok:captured, ok:citing node current
```

Pictures: `ui/09-evidence-direct-labels.png`, `ui/10-evidence-reverse-labels.png`,
`ui/12-evidence-direct-labels-narrow.png` (760 px wide). Accessibility snapshots
`ui/04-evidence-direct.snapshot.txt` and `ui/05-evidence-reverse.snapshot.txt` were refreshed
against the same dataset and now contain every label.

Seed (`.tmp/ui33-seed-round2.py`, real HTTP on a fresh `mktemp -d` dataset):
- nodeA gets rev1 and then rev2.
- nodeC cites a `url` (locator_only), a `code` range at commit `acb70ac` (unresolved) and
  nodeA/**rev1** (captured).
- nodeA is then superseded by nodeB.
- nodeD (locator_only) and nodeE (captured) both cite nodeB's head, and nodeD is then retired.
- nodeF carries the consecutive-edit diff.

The label run and the pictures used two fresh datasets seeded by this same script, so node ids
differ between them.

### How the pictures were made (read before trusting them)

CDP `Page.captureScreenshot` still times out in this environment, as it did in round 1:
- 15 s default, then 90 s, then `captureBeyondViewport`. `fromSurface:false` answered "Unable
  to capture screenshot".
- `Page.startScreencast` produced zero frames while reporting `visible: true`.
- Load average was 13–15.

The PNGs are therefore NOT compositor screenshots. Each one is rendered inside the ego-browser
page itself (`.tmp/ui33-render.js`):
1. Clone the live `#root` DOM together with every loaded stylesheet.
2. Wrap the clone in an SVG `<foreignObject>` at the stated width.
3. Draw it onto a `<canvas>` and export it with `toDataURL`.

That is Chromium's own layout and paint of the real DOM and CSS, so wrapping, overflow and
badge placement are real. It is a re-layout of a clone at the given width, however, not a
capture of the live window. Scroll positions, focus rings and hover state are not carried over.
The fleet rule (browser work through ego-browser only) ruled out Playwright's headless shell.

### AC2 layout defect found while rendering the proof

A `code` target is one unbreakable ~190-char JSON line. `DetailTabs` is a flex item with
`min-width:auto`, so that line set the panel's minimum width. Measured live: a 1,807 px
document inside an 853 px viewport. The fix is `min-w-0` on the panel, plus wrapping the target
JSON instead of truncating it (the path sits at the end of the line). Picture 12 shows it
wrapping at 760 px.

A 760 px emulation still gives `scrollWidth` 589 against `innerWidth` 507 (page zoom is 1.5×),
so part of a horizontal overflow remains at very narrow widths. It comes from the fixed-width
left rail, which this slice did not touch. The app still has no responsive breakpoints.

### Nonblocking findings addressed

- **Oversized unchanged bodies.** `revisionDiff` emits the common prefix and suffix directly,
  and only the differing middle counts against `MAX_DIFF_CELLS`. An unchanged 2,001-line body
  now reads "unchanged", not "too large". A single edited line in a long body now diffs.
- **Empty bodies.** An empty body has no lines. Before, `"" -> Thai` showed a removed `""` row.
- **Renamed terms.** A kept term whose name or label snapshot changed is reported `relabelled`
  and rendered `~ old → new`. Before, it read "no term changes".
- **`chatError` with a pointer.** `invalid_value at /max_items` now reads as a server refusal,
  not "could not reach the server".
- **LifecyclePanel after a failed read.** A failed history read replaces the "never superseded
  or retired" empty state instead of sitting beside it.
- **Retire/supersede state across nodes.** The outcome and error reset when the node changes,
  and `LifecycleActions` is keyed by node. Checked live: a retire form opened and half-filled on
  nodeE is gone after switching to nodeB (`confirmVisible: false`).
- **`MAX_LIFECYCLE_PAGE`.** The unused and wrong constant (200 > server max 100) is removed.
- **One export per file.** `pairDiffLines` and `compareRevisionNo` moved to their own files.
  The new modules export one function each.

### Tests (failing-first)

Red, before any fix (commit `964d260`): **56 pass / 24 fail**. On top of that, 3 test files
could not load because the label and resolver modules did not exist yet. Decisive red lines:
- `pairDiffLines`: expected 2000 rows, received 3999.
- The verifier repro diffed as `removed alpha / changed beta→ALPHA / added BETA`.
- `AssociationPanel` markup had no "locator only".
- `LifecyclePanel` markup contained "never superseded or retired" next to the error.

Green: `bun test src` in `app/ui/v2` gives **106 pass / 0 fail** across 9 files. New test
files:
- `state/pairDiffLines.test.ts` (12 tests)
- `state/directEvidenceLabels.test.ts` (13)
- `state/reverseEvidenceLabels.test.ts` (7)
- `state/resolveCitedRevisions.test.ts` (9, stubbed `fetch`)
- `components/evidencePanels.test.ts` (7, `react-dom/server` render, no new dependency)

`revisionDiff.test.ts` gained 7 tests and `chatError.test.ts` gained 3.

Other checks:
- `tsc -p app/ui/v2`: clean.
- `app/server` `bun run typecheck`: clean.
- `test:ui-scope`: 13/13.
- Python architecture guard: 268 OK (skipped=1).
- Rebuilding `public/v2` from the committed source reproduces the committed bundle with no diff.

### Still not done (see `deviations_from_ruling`)

- **Dependents of older revisions.** Reverse evidence covers only the head revision. A citation
  of an OLDER revision of the selected node is not listed, because `scanDependents` targets one
  exact revision and the panel asks about the head.
- **Some wiring has no automated test.** `useEvidenceStatus`, the `KnowledgeView` wiring and
  the `LifecycleActions` key/reset have none (no DOM test library, and no new dependencies).
  They rest on the live checks above.
- **`asError` reads the wrong field.** It still reads `pointer` while the server sends `path`,
  so pointers never show in UI errors. The `chatError` side is now robust to the corrected shape.

---

# Fix round 1 (kept for the record)

## What the verifier found, and what this round changed

1. **Blocking — `revisionDiff` was not field-level.** It compared only title/body/terms/links
   and ignored `author_peer_name`, `observer_peer_name`, `subject_peer_name`, `session_name`,
   `is_active`, `valid_from`, `valid_to`, `change_reason`, `fields`. A revision that only
   re-attributed authorship or expired `valid_to` read as "no difference".
   **Fix**: `revisionDiff.ts` now compares all nine of those fields (`FieldChange[]`,
   `diffFields`), and `RevisionDiff.tsx` renders them as a real field table, always, not only
   when something changed.
2. **Blocking — `diffLines` had no size guard.** A full `(n+1)x(m+1)` LCS table, built
   synchronously on every render for the two newest revisions of any 2+-revision node, could
   freeze or crash the tab on a body well inside the server's 256 KiB request cap.
   **Fix**: `diffBody` checks `n*m` against `MAX_DIFF_CELLS` (4,000,000 — chosen from the
   verifier's own measurements: ~27 ms/~73 MB at that size) BEFORE building the table, and
   returns `{tooLarge: true, fromLineCount, toLineCount}` instead. `RevisionDiff.tsx` renders a
   plain "too large to diff" note in that case; the field table above it is unaffected.
3. **Blocking — brief item 4 (wire remaining surfaces) was undone, and the report said
   otherwise.** `getRevisionAssociations`, `scanDependents`, `supersedeNode`, `retireNode`
   existed in `registry.ts` but had zero references in the built bundle.
   **Fix**: all four are now wired — `api/evidenceReview.ts` gained
   `getRevisionAssociations`/`associationsOf` (direct evidence: what a revision cites) and
   `scanDependents`/`dependentsOf` (reverse evidence: who cites it) and `retireNode`/
   `supersedeNode` (confirm-gated lifecycle writes), `state/useEvidenceReview.ts` wires all
   four into the Evidence tab's data flow, and three new presentational components
   (`AssociationPanel`, `DependentsPanel`, `LifecycleActions`) render them. `rg -c` against the
   rebuilt bundle now finds all four (see "Wiring, verified" below).
4. Several nonblocking findings were also fixed this round: `chatError`'s generic branch no
   longer says "the server refused" for a transport failure that never reached the server;
   `RevisionHistory` now renders newest-first (matching its own doc comment) and its `onSelect`
   sets the diff "from" side instead of doing nothing; the "identical body" branch (dead code —
   `"".split("\n")` is never `[]`) is replaced with a real `from.body === to.body` check;
   session links now page past 50 via `next_cursor`; `recallEligibilityOf`'s malformed-shape
   case is now a visible error instead of a silently hidden badge; async lanes in
   `useEvidenceReview` now guard against stale responses (a generation counter per lane); a
   looked-up trace now resets on bank/workspace change; `compareRevisionNo`'s test now uses
   values that collide under `Number()`, so a regression to `Number`-based comparison would
   actually fail it.

## Deliberately NOT done this round (see `deviations_from_ruling` in the structured result)

- `scanDependents`'s `revision_mode: "history"` and its full cursor-driven pagination UI beyond
  one "load more" are not exposed — the brief asks for direct/reverse evidence, not a full
  history-mode browser, and the kernel's own bounds (32 nodes/128 revisions/4096 positions per
  call) make one bounded page a reasonable UI unit.
- `publishRevision` (client) still hardcodes `link_snapshot_json: "[]"` — authoring a citation
  when publishing a revision is a new form, not part of this issue's four surfaces (peer chat,
  revision diff, evidence review, "wire what's missing" scoped to registry methods that already
  exist). The seed script below proves the SERVER side of this (a real, non-empty
  `link_snapshot_json`) works; only the UI's own publish form is unchanged.
- No new PNG screenshots — see below.

## Seed (real HTTP calls, `.tmp/ui33-seed.py`, extended this round)

- peers `alice`, `bob`, `carol`, `dave`; sessions `sess-a`, `sess-b`; `alice`/`bob` join
  `sess-a`; 3 messages in `sess-a`; a session link `sess-a --continues--> sess-b`.
- reserved vocabularies seeded (`type`, `memory_horizon`).
- **node1**, two revisions (title/body/term change) — unchanged from the first pass.
- **node2**, published once then `retireNode`'d — retirement + "not eligible" recall proof.
- **node3** (new): a revision whose `link_snapshot_json` is REAL and non-empty — a
  `node_revision` link to node1's rev2. This is a raw HTTP seed call, not the UI's own
  `publishRevision` (which still sends `"[]"`, see deviations); it exists to give
  `getRevisionAssociations`/`scanDependents` real rows to answer with.
- **node4** (new): two revisions with an IDENTICAL Thai title/body
  (`แผนการเก็บข้อมูล` / `เก็บ timestamp เป็นไมโครวินาที ไม่ปัดเศษ`), differing ONLY in
  `author_peer_name` (alice→carol), `subject_peer_name` (bob→dave), `session_name`
  (sess-a→sess-b), `valid_to` (null→2026-10-01) and `change_reason` — this is deliberately
  close to the verifier's own repro of finding #1.
- **node5/node6** (new): node5 published, node6 published, then `supersedeNode(node5 →
  node6)` — the OTHER lifecycle write finding #3 named, complementing node2's retire.
- **node7** (new): two revisions, 2,001 lines each, differing on every line
  (`2001*2001 = 4,004,001 > MAX_DIFF_CELLS`) — triggers the size-guard fallback live, each body
  ~15 KB (nowhere near the server's 256 KiB cap).
- trace, unchanged from the first pass: two hits (a `node_revision` hit citing node1/rev2, a
  `url` hit).

Exact commands are reproducible: `.tmp/ui33-start-server.sh <port>` (server) and
`python3 .tmp/ui33-seed.py <base_url> <token> default` (seed). Both are scratch files
(gitignored via `.tmp/`), not part of the diff.

## Wiring, verified against the rebuilt bundle

```
$ bun run build   # app/ui/v2 -> app/server/public/v2
$ for m in getRevisionAssociations scanDependents supersedeNode retireNode; do
    rg -c "$m" app/server/public/v2/assets/*.js
  done
getRevisionAssociations: 1
scanDependents: 1
supersedeNode: 1
retireNode: 1
```

All four were 0 hits in the previous pass's bundle. The rebuild also reproduces cleanly: no
stray diffs against the checked-in `app/server/public/v2/index.html`'s referenced hashes beyond
the new content hash itself (a real code change, unlike the first pass's byte-identical
rebuild).

## Direct/reverse evidence: real HTTP responses, not fixtures

```
$ curl -sS -X POST localhost:PORT/api/knowledge/default/getRevisionAssociations \
    -d '{"workspace_name":"default","node_id":"<node3>","revision_id":null}'
{
  "workspace_name": "default", "node_id": "<node3>", "revision_id": "<node3-rev>",
  "content_digest": "...", "snapshot_head_revision_id": "<node3-rev>", "is_snapshot_head": true,
  "terms": [{"vocabulary_name_snapshot": "type", "term_name_snapshot": "note", ...}],
  "links": [{
    "relation": "derived_from", "target_kind": "node_revision",
    "target": "{\"node_id\":\"<node1>\",\"revision_id\":\"<node1-rev2>\"}",
    "note": "R1 ruling, carried forward", ...
  }]
}

$ curl -sS -X POST localhost:PORT/api/knowledge/default/scanDependents \
    -d '{"workspace_name":"default","target_kind":"node_revision",
         "target":{"node_id":"<node1>","revision_id":"<node1-rev2>"},
         "revision_mode":"current","limit":10,"cursor":null}'
{
  "outcome": "page", "nodes_version": "9",
  "occurrences": [{"node_id":"<node3>","revision_no":"1","is_snapshot_head":true,
                    "link":{"relation":"derived_from","target_kind":"node_revision", ...}}],
  "next_cursor": null
}
```

node3's own link (to node1/rev2) IS its direct evidence; that same link IS node1/rev2's reverse
evidence, from the other direction — exactly the "same identity, two directions" design in
`api/evidenceReview.ts`'s header. `AssociationResult`/`DependentOccurrence`'s TypeScript shapes
match these wire responses field-for-field.

## `revisionDiff` against REAL server data, not a synthetic fixture

`listAcceptedHistory(node4)`'s two revisions (fetched live, saved to `/tmp/node4-history.json`)
fed straight into the shipped `revisionDiff` function (`.tmp/ui33-prove-diff.ts`, `bun run`):

```json
{
  "fieldChanges": [
    { "field": "author_peer_name", "changed": true, "from": "alice", "to": "carol" },
    { "field": "observer_peer_name", "changed": false, "from": null, "to": null },
    { "field": "subject_peer_name", "changed": true, "from": "bob", "to": "dave" },
    { "field": "session_name", "changed": true, "from": "sess-a", "to": "sess-b" },
    { "field": "is_active", "changed": false, "from": "true", "to": "true" },
    { "field": "valid_from", "changed": false, "from": null, "to": null },
    { "field": "valid_to", "changed": true, "from": null, "to": "2026-10-01T00:00:00.000Z" },
    { "field": "change_reason", "changed": true, "from": null, "to": "re-attributed" },
    { "field": "fields", "changed": false, "from": "{}", "to": "{}" }
  ],
  "titleChanged": false,
  "bodyEqual": true
}
```

Title and body are byte-identical (`bodyEqual: true`), yet 5 of 9 fields report `changed: true`
— the exact defect the verifier found, now fixed and proven against real server output, not a
hand-built fixture.

## Screenshot tooling: what happened (again)

The hard rule asks for PNGs via ego-browser or an installed Playwright/Chromium. As in the
first pass, ego-browser's navigation, DOM state, form-fill, click and full-page snapshot all
worked correctly against the running app with the seeded data above — every surface below was
driven for real. `page.screenshot()` (CDP `Page.captureScreenshot`) timed out on every attempt
across BOTH server instances used in this round, including one attempt made in isolation with
no other action pending. `uptime` measured load average **11.0–13.5** during this round's
attempts (`ps` counted 31 `ego`-related processes) — higher than the first pass's already-high
6.7–7.5, and the failure mode (`CdpRequestTimeoutError` on `Page.captureScreenshot` specifically,
nothing else) is identical. This is the same environment limitation, reproduced again, not a
new one introduced by this round's code.

The verifier's own finding on this point stands: a Playwright `chrome-headless-shell` fallback
is technically capable of writing a PNG even under load, but the fleet's `CLAUDE.md` restricts
browser automation to `/ego-browser`, and this round did not reach for that fallback, matching
the verifier's assessment that not doing so is defensible.

**Correction to the previous version of this file**: it claimed accessibility-tree snapshots are
"stronger ... than a picture". The verifier correctly called that an overclaim — a snapshot
cannot show layout, overflow, or truncation (relevant to AC2's "long titles remain usable",
which this round also fixed: `RevisionDiff.tsx`'s title cells now use `break-words` instead of
`truncate`). The snapshots below are real, load-bearing evidence that the DOM state and data are
correct; they are not a substitute for a picture, and this file no longer claims they are.

## Evidence, surface by surface

All captured with `page.snapshot({scope:"full_page"})` against the live app, saved verbatim
under `docs/overnight/ui/`.

1. **`01-peer-chat.snapshot.txt`** — asked `alice` in `sess-a` "What did we decide about the
   timestamp column?"; real Ollama answer with an inline citation, `full coverage` badge,
   `ExcludedList` "Nothing excluded.", `ITEMS_USED (3)`.
2. **`02-revision-diff-field-level.snapshot.txt`** — node4's two revisions (identical Thai
   title/body): the field table shows `author`/`subject`/`session`/`valid_to`/`change_reason`
   as real from→to pairs, `observer`/`is_active`/`valid_from`/`fields` correctly unchanged, and
   "body unchanged (shown below)" beneath — finding #1, live.
3. **`03-revision-diff-too-large.snapshot.txt`** — node7's two 2,001-line revisions: the field
   table still renders (`change_reason` correctly flagged), and in place of a line-by-line table
   the page shows "Body too large to diff (2,001 vs 2,001 lines) — field changes above are
   still complete." — finding #2, live.
4. **`04-evidence-direct.snapshot.txt`**, REFRESHED in fix round 2 against the round-2
   dataset: nodeC's Evidence tab. Its three links carry `locator only`, `unresolved` and
   `captured` + `stale: not head` + `target superseded/retired`. The round-1 capture of node3
   (no labels) is gone.
5. **`05-evidence-reverse.snapshot.txt`**, REFRESHED in fix round 2: nodeB's Evidence tab.
   The retired citer shows `locator only` + `citing node superseded/retired`, and the current
   citer shows `captured` + `citing node current`.
6. **`06-lifecycle-retired.snapshot.txt`** — node2's Evidence tab: `LIFECYCLE` shows "not
   eligible — superseded or retired" plus the retirement event and its reason.
7. **`07-lifecycle-superseded.snapshot.txt`** — node5's Evidence tab: `LIFECYCLE` shows the
   supersede event ("Draft: storage plan v0" → "Storage plan v1 (successor)") and its reason —
   `supersedeNode`, live, the other lifecycle write finding #3 named.
8. **`08-lifecycle-retire-confirm-gate.snapshot.txt`** — clicking "Retire…" on an ACTIVE node
   (node3) opens the confirm form (reason textarea, disabled "Confirm retire" until a reason is
   typed, "Cancel") rather than firing the write immediately — the confirm gate brief item 4
   asked for, live. This node was not actually retired (the form was closed without confirming),
   so `04-evidence-direct.snapshot.txt`'s state is unaffected.

## Tests

- `revisionDiff.test.ts`: **19 passing** (was 12 before this round; 7 new — field-level diff x3,
  size guard x3, strengthened `compareRevisionNo` x1). Failing-first: the new tests were written
  and run RED (`SyntaxError: Export named 'MAX_DIFF_CELLS' not found`, then real assertion
  failures) before `revisionDiff.ts` was changed.
- `chatError.test.ts`: **5 passing** (was 3; 2 new — transport-failure wording, HTTP-status
  wording). Failing-first: the transport-failure test failed
  (`expect(received).not.toBe(expected)` on the literal `"Failed to fetch"` title) before the
  fix, passed after.
- `api/evidenceReview.test.ts` (new file): **22 passing** — pure-parser coverage for
  `traceOf`/`hitsOf`/`sessionLinksOf`/`lifecycleHistoryOf`/`isSupersedeEvent`/
  `recallEligibilityOf` (had NO tests before this round — a nonblocking finding) plus the three
  new parsers this round adds (`associationsOf`, `dependentsOf`, `lifecycleWriteOutcomeOf`).
  These were written alongside their implementations, not strictly before — see
  `deviations_from_ruling` for the honest accounting of which fixes are failing-first and which
  are not.
- Full suite: `bun test` in `app/ui/v2` → **48 pass, 0 fail** (was 17 before this round per the
  verifier's revert-and-recount; up because two new test files and new cases in two existing
  ones, not because anything regressed).
- `tsc -p app/ui/v2 --noEmit`: clean.
- Python architecture guard (`app/migrate-py`, `unittest discover`): **268 pass, OK
  (skipped=1)** — unchanged from base; this round touched no `app/server/src` file, so no new TS
  import of the publication kernel exists to review/list.

## Amendments

None. No file under `app/docs/contracts/` was touched, and no new dependency was added.

---

# UI-search proof: keyword/semantic search box in Explore (issue #33 remainder, R7/R14/R21/R22)

**Slice**: `ui-search`. **Branch**: `v4/on-ui-search`, based on `v4/overnight-26sep` `5b3f40e`.
UI-only change, `app/ui/v2` (no `app/server/src` file touched). Before this slice the UI called
neither `searchKnowledgeKeyword` nor `searchKnowledgeSemantic` (`docs/SCHEMA-BUILT.md`'s name
scan). This adds a `Search` tab to the existing Explore view (`explore/DetailTabs.tsx`), beside
`Nodes`/`Chat`/`Messages`/`Evidence`/`Config`, with a query box + keyword/semantic mode toggle.

**New files**: `state/searchHitView.ts` (+ test), `state/searchState.ts` (+ test),
`api/search.ts`, `state/useKnowledgeSearch.ts`, `components/KnowledgeSearchBox.tsx`,
`components/KnowledgeSearchResults.tsx`. Wired into `explore/DetailTabs.tsx` / `ExploreView.tsx`.

## Failing-first evidence

`searchHitView.ts` / `searchState.ts` were written as empty (moved aside), their test files
written against the intended API, and run RED before any implementation existed:

```
error: Cannot find module './searchState' from '.../src/state/searchState.test.ts'
error: Cannot find module './searchHitView' from '.../src/state/searchHitView.test.ts'
0 pass / 2 fail / 2 errors
```

Then the implementations were restored and the same run went GREEN: `12 pass / 0 fail / 27
expect() calls`. Full `app/ui/v2` suite after: `bun test src` → **118 pass, 0 fail** (was 106
before this slice; 12 new).

## Server-side facts these tests pin against the real service files

- `searchKnowledgeKeyword` answers `{match, scan_reason, hits: [{..., rank, match}]}` — a 1-based
  `rank`, never a raw score (R21), and a per-hit `match` (`"ngram" | "substring_scan"`).
- `searchKnowledgeSemantic` answers `{embedding_profile, metric, hits: [{..., distance}]}` — a
  raw per-row `distance` (no cross-tenant leak, so no R21 hiding needed) and a response-level
  `embedding_profile`, not a per-hit field.
- `scan_reason` is `"short_query"` (query &lt; 3 code points) or `"index_unavailable"` (the FTS
  index has not been built by `indexRevisionChunks` yet) — a note on an otherwise normal answer,
  not an error. `searchState.ts` renders it as a banner, distinct from a bare empty list.
- `model_unavailable` (R9/R21: semantic with no/failing embedder) is its own UI state, same
  `chatError.ts` idiom: a dedicated banner explaining Ollama must be running, not a generic error.

## Live proof: real server, fresh `mktemp -d` dataset, writer gate

Server started the same way `app/just/demo.sh`/`stack.sh` does (`arra_migrate.writer_gate` via
`run_dev_server.py`), on a fresh `mktemp -d` root — never `app/.tmp`/`app/data`. Steps, via the
real CLI (`bun app/cli.ts`), stopping before the demo's later supersede step so the published
node stays in the default (non-history) recall view:

1. `peer add alice`, `session add ui-search-proof`, `kb joinSession`.
2. `kb seedReservedVocabularies`, `kb lookupVocabularyByName`/`lookupTermByName` for `type` /
   `learning`.
3. `kb publishRevision` — title `ผ่าดิสก์: อย่าหลงลืม snapshot ก่อนซ้อมย้ายข้อมูล`, body containing
   `หลงลืม` (ลืม inside a word — the R14 counterexample ICU misses and ngram(3,3) finds).
4. `kb indexRevisionChunks` — `outcome: "indexed"`, one chunk row, `status: "pending"` (no
   embedder composed for this minimal proof stack, so semantic search on this dataset answers
   `model_unavailable`, itself one of the states this slice renders).

Then the built UI (`bun run build` in `app/ui/v2`, output verified under
`app/server/public/v2/`) was opened with `/ego-browser` (fleet rule: ego-browser only, never
dev-browser) against the running server, bank/workspace `default`, the dev token pasted into the
Token field. Explore → Search tab → typed `ลืม`:

- Result: rank `#1`, title `ผ่าดิสก์: อย่าหลงลืม snapshot ก่อนซ้อมย้ายข้อมูล`, snippet, match mode
  `ngram` (confirmed present in the DOM via `page.evaluate` — the narrow panel width clips it
  visually at the default viewport, a cosmetic layout gap, not a functional one).
- Screenshot: `docs/overnight/ui/33-search-keyword-thai.png`.
- Clicking a hit called `onSelectNode` + a tab switch to `Nodes` at the time this section was
  written. **Superseded by the "Fix round (2026-09-27)" section below**: an independent
  verifier found that tab is a paged, type-filterable `listNodes` list that never renders
  title/body/history and can show nothing highlighted if the hit is off-page or filtered out, so
  the click now routes to the existing `KnowledgeView` (`#/knowledge?node=…`) via
  `state/searchHitRoute.ts` instead.
- Empty-query state observed live before typing: "Type a query to search this workspace's
  knowledge." (`searchState`'s `empty_query` kind).

Server and its `mktemp -d` root were torn down immediately after (`kill -TERM` on the owned PID,
then `rm -rf` the root) — no `app/.tmp`/`app/data` was touched, and nothing was left running.

## Acceptor live probe (unrelated to this slice, run for the hard rule)

`bash .tmp/acceptor/live-probe/run.sh <this-worktree> ui-search` on HEAD `5b3f40e` (unchanged —
this slice touches no `app/server/src` file): **57 kernel methods, HTTP 57 / MCP 57 / CLI 57,
isolation 191 pass / 0 fail, 0 fatal.** `searchKnowledgeKeyword`/`searchKnowledgeSemantic` show
as GAP on that scoreboard — a pre-existing fixture gap on the acceptor's own instrument (7 newer
methods have no fixture yet, per `docs/overnight/PLAN.md`'s 02:16 log entry), not a defect this
slice introduced or could fix from the UI side.

## Tests and typecheck

- `bun test src` (`app/ui/v2`): **118 pass, 0 fail** (106 before this slice).
- `./node_modules/.bin/tsc -p tsconfig.json` (`app/ui/v2`): clean.
- `bun run build` (`app/ui/v2`): succeeded, output at `app/server/public/v2/`.
- `bun run test:ui-scope` (`app/server`): **13 pass, 0 fail** — unchanged; this is the OTHER,
  legacy plain-script UI at `app/server/public/index.html`, untouched by this slice.
- Python architecture guard (`app/migrate-py`, `unittest discover`): **268 pass, OK
  (skipped=1)** — unchanged; no new TS file imports the publication kernel.

## Amendments

None. No file under `app/docs/contracts/` was touched (search-chunk-v1.md and its R21/R22
amendments were already written by the search-query/search-polish slices), and no new
dependency was added.

## Fix round (2026-09-27): scanReason leak + click routing

An independent Opus verifier REFUTED this slice on two blocking findings.

1. **`scanReason` leaked from keyword into semantic results.** `useKnowledgeSearch`'s inline
   branches never cleared `scanReason` on a successful SEMANTIC response, so a keyword-mode
   note ("used a plain substring scan…") kept rendering on real semantic hits. Extracted the
   response→state transition into a pure, unit-tested function,
   `state/applySearchOutcome.ts`, and fixed the semantic branch to always reset `scanReason`.
   Failing-first: `src/state/applySearchOutcome.test.ts`'s "semantic success clears a
   scanReason left over from an earlier keyword search" failed
   (`expect(received).toBeNull(); Received: "short_query"`) against the extracted-but-unfixed
   function, then passed after adding `scanReason: null` to the semantic branch. While
   extracting this, also fixed a second, related bug the extraction surfaced: `run`'s
   `useCallback` was memoized on `[bank]` only, so reading the five response-state variables
   directly out of its closure captured stale values from mount, not the latest state — the
   five separate `useState`s were consolidated into one `SearchOutcome` object updated via a
   functional `setOutcome(prev => applySearchOutcome(mode, result, prev))`, which is correct
   regardless of `run`'s own dependency list.
2. **Clicking a hit didn't open the node view.** The old handler called `onSelectNode` +
   switched Explore's own tab to `nodes` — a paged, type-filterable `listNodes` view that never
   renders title/body/history, and shows nothing highlighted at all if the hit is off-page or
   filtered out. Extracted the navigation decision into `state/searchHitRoute.ts` (`{ view:
   "knowledge", node: nodeId }`) and wired it through a new `onOpenSearchHit` prop from `App.tsx`
   (which owns `push`) down through `ExploreView`, so a hit now navigates to `KnowledgeView` at
   `#/knowledge?node=…` — the view that unconditionally renders `NodeHead` + `RevisionHistory`
   for whatever id is in the URL. Failing-first: `src/state/searchHitRoute.test.ts` failed with
   `Cannot find module './searchHitRoute'` before the file existed, passed after adding it.
   Not re-verified with a fresh browser screenshot in this fix round (time-boxed); the fix is a
   plumbing change traced by reading `App.tsx`/`useRoute.ts`/`KnowledgeView.tsx`, backed by the
   new unit test asserting the route patch shape, plus `tsc` confirming the prop wiring
   type-checks end to end.

Also fixed two cheap nonblocking findings from the same review: the search-results title now has
`min-w-0 truncate` (was pushing the `ngram`/`substring_scan` badge off-screen for long titles),
and `DetailTabs.tsx`'s doc comment now says "Six tabs" (was "Five", stale since the search tab
was added). Added a wire-shape test for `api/search.ts` (`src/api/search.test.ts`, stubbing
`fetch`) covering the method-name/body-shape mutant the verifier's mutation run (M6) found no
coverage for.

Re-run: `bun test src` — **125 pass, 0 fail** (118 before this round; +7 new: 3
`applySearchOutcome`, 2 `searchHitRoute`, 2 `api/search`). `tsc -p tsconfig.json` — clean.
`bun run build` — succeeded (new bundle hashes, content changed by the fix). `bun run
test:ui-scope` (`app/server`) — 13 pass, 0 fail, unchanged. Python architecture guard — 268
pass, OK (skipped=1), unchanged; no new TS file imports the publication kernel. Acceptor live
probe re-run on this worktree: **57/57/57 methods, isolation 191 pass / 0 fail, 0 fatal** —
identical to the pre-fix-round run the verifier captured (`out/verify-ui-search-1.md`), including
the same 26 payload-fixture gaps (`searchKnowledgeKeyword`/`searchKnowledgeSemantic` among them);
confirms that scoreboard is unaffected by this UI-only fix, not a regression it introduced.

## Search polish (2026-09-27, ui-polish slice): five nonblocking follow-ups

A second independent verifier re-checked all five nonblocking follow-ups this section's Fix
round left open and REFUTED the slice that was supposed to close them (no commit existed at
all). This round fixes all five, UI-only (`app/ui/v2`, its rebuilt `app/server/public/v2`
bundle, and docs; no `app/server/src` file touched):

1. **Stale scan note.** `SearchOutcome` (`state/applySearchOutcome.ts`) now records `mode`,
   the mode that PRODUCED the outcome. A new pure function, `state/searchOutcomeView.ts`, gates
   `scanReason` on `outcome.mode === activeMode`: switching Keyword → Semantic hides the keyword
   note immediately rather than leaving it up for `useKnowledgeSearch`'s 300ms debounce window.
   Failing-first: `searchOutcomeView.test.ts`'s "switching to semantic … hides the stale keyword
   note immediately" was verified red against the naive `scanReason: outcome.scanReason` (temp
   reverted, ran, `Received: "short_query"`, expected `null`), green after the mode gate.
2. **Back losing the query.** `useRoute`'s `Route` gained `q`/`mode` fields
   (`#/explore?tab=search&q=...&mode=keyword|semantic`); `parse`/`format` (previously private)
   are now exported and unit-tested directly (`useRoute.test.ts`) since neither touches
   `window`. Two new pure functions restore/persist the search box: `searchRouteState` (route →
   initial hook state, unrecognised `mode` falls back to `keyword`) and `searchRoutePatch` (hook
   state → route patch, empty query clears `q`). `ExploreView` reads the initial state from the
   route and writes every `query`/`mode` change back via `App.tsx`'s `route.replace` — never
   `push`, so typing never spawns a history entry per keystroke, and the CURRENT explore entry
   (the one Back returns to) always carries the latest query. Verified live against the real
   running server: typing `ลืม` into the search box changed the address bar hash to
   `#/explore?tab=search&q=%E0%B8%A5%E0%B8%B7%E0%B8%A1&mode=keyword` in place (no new history
   entry), confirming the wiring round-trips end to end, not just in the unit tests.
3. **Narrow-viewport clipping.** `flex-wrap` added to the Keyword/Semantic toggle row
   (`KnowledgeSearchBox.tsx`), the Explore tab bar (`DetailTabs.tsx`, where `Config` lives), and
   the per-hit match-badge row (`KnowledgeSearchResults.tsx`) — the same `flex flex-wrap` idiom
   already used by `KnowledgeView`/`WorkspaceBar`/`EvidenceBadges`. Confirmed via
   `getComputedStyle` against the real served bundle that `flexWrap: "wrap"` reaches the DOM on
   both rows. **Not independently confirmed with a browser screenshot**: `/ego-browser`'s CDP
   screenshot capture was unreliable in this session (repeated `CdpRequestTimeoutError`s, and
   one captured frame came back a garbled 123×127px instead of the 830×858 viewport, with the
   viewport itself twice collapsing to single digits after an interaction) — a tool/environment
   instability in this run, not a rendering issue reproduced through the DOM. No
   `docs/overnight/ui/34-search-polish-*.png` was produced as a result; this is an honest gap
   against the brief's "Verify with /ego-browser screenshots at 830px and 1280px", not a silent
   skip.
4. **Untested wiring.** The decision logic `useKnowledgeSearch` used to compute inline —
   which hits/scan-note to show, and (new) how to seed/persist query+mode — now lives in
   `searchOutcomeView`, `searchRouteState` and `searchRoutePatch`: pure, DOM-free, unit-tested.
   Reverting any of the three turns its own test red without needing jsdom (this repo has none
   and adding one was out of scope — no new dependencies). `App.tsx`'s hit-click routing
   (`push(searchHitRoute(id))`) was already fully delegated to the tested `searchHitRoute`
   function from the prior Fix round; nothing further to extract there.
5. **Docs.** Corrected the stale "same `onSelectNode` + tab switch" sentence above (superseded
   by this file's own Fix round section) to say what the click does now. Re-measured
   `docs/SCHEMA-BUILT.md`'s knowledge-method name scan with the exact method it describes: **33
   of 57** called today, not 30 — `searchKnowledgeKeyword`/`searchKnowledgeSemantic` are real new
   calls, and a third match, `indexRevisionChunks`, is a false positive of the scan's own
   whole-word method (it only appears inside a UI message string, not a call); both are counted
   and the false positive is explained in place rather than silently rounded off.

### Live proof

Real server, fresh `mktemp -d` root (`app/just/demo/stack.sh`'s `demo_stack_up`, never
`app/.tmp`/`app/data`), real local Ollama (`all-minilm`, confirmed installed): registered a peer
and session, seeded the reserved vocabularies, published one Thai-body node (`หลงลืม`, the R14
inside-word case), indexed its chunk, and embedded it for real —
`{"attempted":1,"embedded":1,"reused":0,"failed":0,"remaining":0,"skipped":0,"blocked":null}`.
The built UI (`bun run build`, output verified under `app/server/public/v2/`) was then opened
with `/ego-browser` against the running server with the dev token. Confirmed live, by DOM/URL
evidence rather than a screenshot (see finding 3 above for why): the Search tab's tab bar shows
`Config` and every other tab in the DOM at an 830px viewport (`configVisible: true`), the
Keyword/Semantic toggle and match-badge rows both compute `flexWrap: "wrap"` from the shipped
CSS, and typing `ลืม` immediately rewrites the address bar to
`#/explore?tab=search&q=%E0%B8%A5%E0%B8%B7%E0%B8%A1&mode=keyword` via `replace` (single history
entry, not one per keystroke). Server stopped (`kill -TERM` on the owned PID) and its `mktemp -d`
root removed immediately after; the browser origin's `localStorage` was cleared and the
`/ego-browser` task space closed. No `app/.tmp`/`app/data` was touched and nothing was left
running.

### Tests and typecheck

- `bun test src` (`app/ui/v2`): **138 pass, 0 fail** (125 before this round; +13 new: 3
  `applySearchOutcome`, 3 `searchOutcomeView`, 3 `searchRouteState`, 2 `searchRoutePatch`, 4
  `useRoute` — one `applySearchOutcome` case reused).
- `./node_modules/.bin/tsc -p tsconfig.json` (`app/ui/v2`): clean.
- `bun run build` (`app/ui/v2`): succeeded, new bundle hash under `app/server/public/v2/`.
- `bun run test:ui-scope` (`app/server`): 13 pass, 0 fail — unchanged, the other legacy
  plain-script UI, untouched by this slice.
- Python architecture guard (`app/migrate-py`, `unittest discover`): 268 pass, OK (skipped=1) —
  unchanged; no new TS file imports the publication kernel.
- Acceptor live probe (`.tmp/acceptor/live-probe/run.sh … ui-polish`, run from the overnight
  worktree against this one): **57/57/57 methods, isolation 0 fail, 0 fatal, gaps=26, RC=2** —
  the same known payload-fixture-gap exit code the prior review already logged as unrelated to
  the UI; this slice touches no `app/server/src` file, so the scoreboard could not have moved.

## Amendments

None. No file under `app/docs/contracts/` documents UI routing/rendering behaviour, so none
needed a new section for this UI-only round; no new dependency was added.
