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
4. **`04-evidence-direct.snapshot.txt`** — node3's Evidence tab: `DIRECT EVIDENCE` shows its one
   term and its one link (`node_revision` / `derived_from` / the raw target JSON) — direct
   evidence, live.
5. **`05-evidence-reverse.snapshot.txt`** — node1's Evidence tab: `REVERSE EVIDENCE` lists node3
   (truncated id) citing node1's rev1 via `node_revision`/`derived_from` — reverse evidence,
   live, same identity as #4 seen from the other side.
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
