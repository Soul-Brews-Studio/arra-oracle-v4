# UI proof: ui-cite (#33 AC1 cite → correct → supersede, AC3 labels)

Branch `v4/on-ui-cite`. Rulings: `DECISIONS.md` R6 (the sealed vocabulary), R10
(`conclusion` is reserved) and R12. The UI is in `app/ui/v2` only. `app/server/src` is
unchanged.

## What was broken

- **Cite**: `publishRevision` hardcoded `link_snapshot_json: "[]"`, and the form had no
  link field, so citing was impossible from the browser.
- **Correct**: there was no correct action, only one generic publish button with a type
  dropdown.
- **Lifecycle**: a superseded or retired node's publish form stayed live, with no label.

## Live run

The stack was fresh and gated: `app/just/demo/stack.sh` `demo_stack_up`, which runs
target19 + legacy15 in `mktemp -d`, with the dev policy and the writer-gated server on a
free port. The bundle was built with `bun run build` from this branch. The browser was
`/ego-browser`, space 136. Every step below went through the UI, except that two
revision ids were read with an in-page `getAcceptedHead`/`listAcceptedHistory` fetch for
the record.

| # | Step | What the screen showed | Screenshot |
|---|---|---|---|
| 1 | Seed the vocabularies, create node A "Server port", revise it to #2 | History #2 HEAD, #1. The form has an EVIDENCE LINKS editor and a separate CORRECT section | `ui/35-cite-01-created-revised.png` |
| 2 | Draft B with a link to a well-shaped but unknown node_revision | An inline `revision_id must be a 21-character id` while typing. On submit the server refused, and the UI showed `refused invalid_reference` | `ui/35-cite-02-refused-unknown-target.png` |
| 3 | Draft B "Port conventions": `supports` → `node_revision`, A #2 picked from the loaded-revisions list, with a note | The link row is filled, and the create button is enabled | `ui/35-cite-03-link-picked.png` |
| 4 | Explore → Evidence for B | DIRECT EVIDENCE: `node_revision · supports · {"node_id":"mRIzEfUC…","revision_id":"zgwvFnI3…"} · locator only · current head` | `ui/35-cite-04-direct-evidence.png` |
| 5 | Explore → Evidence for A | REVERSE EVIDENCE: `dJXlKj1u… rev 1 · node_revision · supports` | `ui/35-cite-05-reverse-evidence.png` |
| 6 | Knowledge → A → Correct: corrects #2, title "Test server port is 47779", with a reason | This form explains what Correct does before it is used | `ui/35-cite-06-correct-form.png` |
| 7 | Record the correction. The new node C opens. Its Evidence tab is shown | `type:correction`, LINKS (1): `node_revision · corrects · A #2` | `ui/35-cite-07-correction-evidence.png` |
| 8 | Evidence tab for A → Supersede… with C's node and revision ids → Confirm | `accepted`. Lifecycle shows `not eligible — superseded`, `→ Test server port is 47779`. Reverse evidence lists B (supports) and C (corrects) | `ui/35-cite-08-superseded-evidence-tab.png` |
| 9 | Knowledge → A | A **SUPERSEDED** label and an "open successor" link (`#/knowledge?node=yv8Z0uKY…`). The fieldset is disabled, so the publish, record-correction and title inputs are all disabled, with the explanation shown. Clicking the link opened C, which has no label | `ui/35-cite-09-knowledge-superseded-disabled.png` |
| 10 | History of A after all of the above | Both revisions are readable. `listAcceptedHistory` returns #1 "The dev server listens on 47777." and #2 "…test server on 47778." unchanged, each with `link_snapshot_json` `[]`. The correction did not touch them | `ui/35-cite-10-history-after-supersede.png` |

The DOM state read at step 9 was `fieldsetDisabled: true, publishDisabled: true,
correctDisabled: true, titleInputDisabledByFieldset: true` and
`successorHref: "#/knowledge?node=yv8Z0uKYgUiUIc1qxlq4a"`.

## Found live and fixed

After a revise, clicking "new" could leave the previous node's head on screen. The cause
is that `useKnowledge.refresh` has no guard against a stale response. As a result, the
draft offered Correct and would have published with that node's head as its base.
`state/writableHead.ts` fixes this: its test was written first, and the fix is commit
`3e84d3d`. The NodeHead display itself still shows the stale head on a draft. That is a
pre-existing display race, and writes now ignore it.

## Teardown

- `demo_stack_down` killed the server pid and removed the mktemp root. The removal was
  checked: `ls` reports that the root does not exist.
- The origin's localStorage went from 4 keys to 0, and sessionStorage was cleared.
- The ego-browser space was finished with `keep: []`.
- `app/server/public/v2` was restored with `git checkout` + `git clean` and was not
  committed.

## Hardening (2026-09-27, ui-cite2, PR #113 wave 5 findings)

Branch `v4/on-ui-cite2`, base `84061c9` (PR #113's head). Fixed all five non-blocking
findings in `.tmp/ui-cite-wave5-findings.txt`:

1. **Test gap on the core cite wiring** (`PublishForm.tsx:50`, `links: built.entries`,
   mutant M4 -> `links: []`). Extracted `state/buildPublishInput.ts` (the same
   pure-builder idiom as `buildCorrection.ts`) and added test-only seams
   (`initialTitle`/`initialBody`/`initialLinks`/`submitRef`) to `PublishForm` and
   `CorrectForm`, since this repo's render tests are `react-dom/server` with no jsdom
   and cannot click a real button. `citeCorrect.test.ts`'s new "submit sends the link
   editor's built entries to onPublish" test fills a link row, calls the captured
   `submit()` directly, and reads what `onPublish` received. Confirmed red under M4
   (`received!.links.length` 1 -> 0), green after, red again -> green on revert.
2. **Tautological gate assertions** (`citeCorrect.test.ts:90-91`, empty title/body made
   `canSubmit` false regardless of gate). Added a dedicated pair of tests that render
   `PublishForm`/`CorrectForm` directly with fields FILLED (`initialTitle`/`initialBody`)
   and `disabled` set explicitly, so only the gate can flip the button. Confirmed this
   catches an M14-style mutant (dropping `!disabled` from `CorrectForm`'s `canSubmit`)
   that the old fieldset-only assertions missed.
3. **Generic PublishForm let `type: correction` through with no `corrects` link**
   (#33 TODO4). `PublishForm` now refuses to submit (`canSubmit` false) when
   `typeTerm === "correction"` and no link in the editor has `relation: "corrects"`,
   and shows why inline: "type "correction" needs a corrects link below ..., or use the
   Correct action instead." Live-verified below.
4. **`useKnowledge.publish` resolved `true` on a `conflict` outcome** (HTTP 200,
   `{outcome:"conflict", reason}`) — the doc comment at the old line 186 was also wrong.
   `publish` now reads `result.body.outcome`; a `conflict` resolves `false` and surfaces
   `describeConflict(reason)` through `error` (a human sentence per reason:
   `node_id`/`stale_base`/`node_retired`/`operation_digest`). Live-verified below.
5. **Design choice, documented rather than silently kept**: the lifecycle gate blocks
   Correct (and publish) on a superseded/retired node from this client, even though the
   server itself would still accept a correction filed directly against that node's old
   accepted revision (the gate is a UI-side choice, not a server rule). `lifecycleGate.ts`'s
   `explanation` now says this in both the superseded and retired cases, so a user reading
   the banner is told the true scope of the block, not an implied server rule.

### Live proof (fresh gated stack, items 3 & 4)

Stack: `.tmp/ui-cite2-stack.sh` (same building blocks as `app/just/demo/stack.sh`
`demo_stack_up`/`demo_stack_down` — target19 dataset, dev policy/token, writer-gated
server, all under a fresh `mktemp -d`, never `app/.tmp`). Browser: ego-browser
(playwright MCP), bundle rebuilt with `bun run build` from this branch.

| # | Step | What the screen showed | Screenshot |
|---|---|---|---|
| 1 | Seeded vocabularies; new draft; title+body filled; type set to `correction`, no link added | Inline: `type "correction" needs a corrects link below ..., or use the Correct action instead -- publish refuses a correction without one.` `create node` stayed disabled | `ui/38-cite2-01-correction-blocked.png` |
| 2 | Published node rev #1 (type `note`). Out-of-band `fetch("/api/knowledge/default/publishRevision")` (simulating a concurrent writer) advanced the SAME node to rev #2 using rev #1 as base. Back in the still-showing-rev-#1 UI, filled a new title/body and clicked "publish revision" | `outcome:"conflict", reason:"stale_base"` came back HTTP 200; the UI showed a `refused` banner: `publish refused: this node was revised by someone else first -- refresh and try again`. Head display stayed at #1 -- no silent navigation, no cleared error | `ui/38-cite2-02-publish-refused-reason.png` |

Teardown: `.tmp/ui-cite2-stack.sh down` sent `SIGTERM` to the server pid and `rm -rf`'d
the mktemp root (`ls` afterward: no such file or directory). The origin's localStorage
and sessionStorage were cleared via `page.evaluate` before closing the tab (0 keys each,
confirmed in the eval's return value).

### Test evidence

`bun test src` (app/ui/v2): **168 pass, 0 fail** across 23 files (was 165/0/22 before this
pass -- 3 new test files: `buildPublishInput.test.ts`, `describeConflict.test.ts`, and new
cases inside `citeCorrect.test.ts`). `./node_modules/.bin/tsc -p tsconfig.json`: clean.
`PYTHONPATH=src .venv/bin/python -m unittest discover -s tests` (app/migrate-py): 269
tests, `OK (skipped=1)` -- unaffected, since this slice touches only `app/ui/v2/src`.

Manual mutants applied and reverted, each confirmed red -> green:
- M4 (`PublishForm.tsx`'s `built.entries` -> `[]`): 2 tests fail (`buildPublishInput`
  count assertion, and the correction-link acceptance test).
- M14-equivalent (`CorrectForm`'s `canSubmit` dropping `!disabled`): the new
  "gate itself ... disables" test fails (button renders enabled with `disabled: true`).
- Correction-guard removal (`canSubmit` dropping `!correctionMissingLink`): the new
  "refuses type: correction without a corrects link" test fails (button renders enabled).

## Known limits

- The form clears its fields when submitted, even if the server refuses. This is the
  existing PublishForm idiom, now also applied to its links. The refusal is shown, but
  the typed draft is lost.
- Offered kinds: 5 of the 11. See the amendment in
  `app/docs/contracts/revision-evidence-v1.md`.
- The KnowledgeView wiring (which gate and which head it passes) is proven by this
  browser run. The unit tests pin `NodeWritePanel`, `LifecycleBanner`, `PublishForm` and
  the pure builders, because `renderToStaticMarkup` runs no effects and so cannot reach a
  loaded node inside `KnowledgeView`.
