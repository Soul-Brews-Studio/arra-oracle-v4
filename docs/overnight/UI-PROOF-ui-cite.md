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
5. **Design choice, documented rather than silently kept** -- corrected in the hardening
   pass below (a first attempt here was itself half-fixed and half-honest; see
   "Hardening" for what an independent verifier caught and how it was actually closed).

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

`bun test src` (app/ui/v2): **168 pass, 0 fail** across 23 files (measured baseline at
`84061c9` by the independent verifier: 158 tests across 21 files -- this pass adds 2 new
test files, `buildPublishInput.test.ts` and `describeConflict.test.ts`, plus 10 new tests:
5 in `citeCorrect.test.ts`, 3 in `buildPublishInput.test.ts`, 2 in `describeConflict.test.ts`).
`./node_modules/.bin/tsc -p tsconfig.json`: clean.
`PYTHONPATH=src .venv/bin/python -m unittest discover -s tests` (app/migrate-py): 269
tests, `OK (skipped=1)` -- unaffected, since this slice touches only `app/ui/v2/src`.

Manual mutants applied and reverted, each confirmed red -> green:
- M4 (`PublishForm.tsx`'s `built.entries` -> `[]`): killed by `citeCorrect.test.ts`'s
  "submit sends the link editor's built entries..." and "a corrects link on
  type: correction is accepted" (2 tests fail). **Correction (hardening pass)**:
  `buildPublishInput.test.ts` does NOT catch M4 and never could -- it only tests
  `buildPublishInput`'s identity mapping of `links`, not the `PublishForm.tsx` call site
  that decides what gets passed in. An earlier version of this doc, and a doc comment in
  `buildPublishInput.ts` itself, wrongly credited that file's test with the kill; both are
  now corrected (see `buildPublishInput.ts`'s doc comment).
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

## Hardening (2026-09-27, fix round on top of `v4/on-ui-cite2` at `84061c9`)

Current totals after this round: `bun test src` (app/ui/v2) **173 pass, 0 fail** across
24 files (+1 new file, `interpretPublishResult.test.ts`, +5 tests over round 1's 168/23).
`tsc -p tsconfig.json`: clean. Python architecture guard: 269 tests, `OK (skipped=1)`,
unaffected (still only `app/ui/v2/src` touched).

An independent Opus verifier reviewed the round-1 hardening above and found one blocking
gap plus several honesty problems in this doc. Addressed here:

1. **Blocking: no test covered the conflict-vs-success decision itself.** The verifier
   reverted only `useKnowledge.ts` to `84061c9` and ran `bun test src`: **168 pass, 0
   fail** -- nothing in the suite could see the revert. Two mutants survived the WHOLE
   suite: mutant G (`outcome === "conflict"` -> `outcome === "nope"`, so a real conflict
   resolves `true`) and mutant F (`setError(describeConflict(reason))` ->
   `setError(null)`, so a refusal is silent). Fix: pulled the decision out into
   `state/interpretPublishResult.ts` -- same shape as `applySearchOutcome.ts` ("the
   single, unit-tested place that decides" a result), and wrote
   `interpretPublishResult.test.ts` FIRST.
   - Red (module did not exist yet): `error: Cannot find module
     './interpretPublishResult'` -- `0 pass / 1 fail / 1 error`.
   - Green after implementing: `5 pass, 0 fail`.
   - Mutant G re-applied directly to `interpretPublishResult.ts`: 2 of the 5 tests fail
     (`Expected: false / Received: true`).
   - Mutant F re-applied (conflict branch returns `error: null as unknown as string`): 2
     of the 5 tests fail (`.toContain` on a non-string throws).
   - Both mutants reverted; suite back to green. `useKnowledge.publish` now calls
     `interpretPublishResult(result, describe)` instead of inlining the `outcome ===
     "conflict"` check.
   - **Correction (round 3): the next two claims this item made were false.** It said
     "the exact code path the verifier flagged is the one under test" and that mutants G
     and F were killed. The round-2 verifier showed that neither was true at the call
     site. Reverting only `useKnowledge.ts` to `84061c9` left `bun test src` at **173
     pass, 0 fail**. So did G moved to the call site
     (`interpretPublishResult({ ...result, body: null }, describe)`) and F at its real
     location (`setError(interpreted.error)` -> `setError(null)`). The mutants above were
     killed only after being redefined as edits inside `interpretPublishResult.ts`. The
     red shown above is a module-not-found red, not a behavioural one. Round 3 below
     closes the gap and gives the red lines.
2. **`UI-PROOF-ui-cite.md` overclaimed the lifecycle-gate disclosure.** Item 5 above said
   `lifecycleGate.ts`'s explanation "now says this in both the superseded and retired
   cases"; the diff had touched only the superseded branch, and the retired branch
   (`lifecycleGate.ts:70`) was byte-identical to `84061c9` -- no UI-side-choice
   disclosure at all. Separately, the superseded wording itself overstated the claim: it
   said blocking BOTH publish and correct was "a UI-side choice, not a server rule," but
   the server DOES refuse publish onto a superseded/retired node
   (`service.publishRevision.ts` returns `outcome: "conflict", reason: "node_retired"`).
   Only blocking CORRECT is this client's own choice -- `validateLinkReferences.ts`
   checks a `corrects` link's target is in the accepted ancestry and never looks at
   lifecycle, so the server would accept a correction filed directly against an old
   accepted revision of a terminal node. Fix: both branches now share one
   `TERMINAL_SCOPE_NOTE` that says "Publishing here would also be refused by the server
   itself. Blocking a correction here, though, is this client's own choice...". Failing
   first: `lifecycleGate.test.ts`'s two updated assertions were run against the
   `84061c9`-era `lifecycleGate.ts` and both failed (`Expected to contain: "Publishing
   here would also be refused by the server itself" / Received: "This node was
   retired..."` and the equivalent for superseded's old wording); green after the fix.
3. **Nonblocking, fixed anyway (cheap):**
   - `buildPublishInput.ts`'s doc comment claimed a mutant dropping `links` to `[]` at
     the `PublishForm.tsx` call site "must turn `buildPublishInput.test.ts` red." Verified
     false by re-running mutant A: `buildPublishInput.test.ts` stays **3 pass, 0 fail**;
     only `citeCorrect.test.ts` catches it (2 fail). Comment rewritten to say so and to
     point at the tests that actually do.
   - This doc's baseline ("165/0/22 before this pass") was wrong; the verifier measured
     158 tests across 21 files at `84061c9`. Corrected above, along with the actual delta
     (2 new files, 10 new tests).
   - `PublishForm.tsx`'s `CORRECTION_NEEDS_LINK` copy ended "-- publish refuses a
     correction without one," which reads as a server rule. `rg` finds no
     correction/corrects enforcement in `app/server/src` -- it is only this form's own
     guard. Reworded to "-- this form will not submit a correction without one." The
     live-proof screenshot `ui/38-cite2-01-correction-blocked.png` above predates this
     wording fix and still shows the old sentence; no new screenshot was captured this
     round (see below).
4. **Not done, disclosed rather than papered over:** this round did not re-run the
   `/ego-browser` live proof. The logic fixed here (`interpretPublishResult`, the
   lifecycle-gate copy) has no new externally-visible behavior beyond what
   `38-cite2-02-publish-refused-reason.png` already shows (a conflict still surfaces as a
   refused banner with the server's reason) -- the refactor moves *how* that decision is
   tested, not what the user sees. Given the round's time box, `bun test`, `tsc`, the
   Python architecture guard, and the mutant runs above were prioritized over a repeat
   browser pass. `CorrectForm.submitRef` (a test-only seam no test currently drives) and
   the "form clears typed links after a conflict" known limit were left as-is, matching
   the verifier's own nonblocking/no-regression read of them. (Round 3 removed
   `CorrectForm.submitRef`.)

## Hardening round 3 (2026-09-27, on `fc72916`, which merges main `883fca7`)

The round-2 verifier refuted item 1 above: the call in `useKnowledge.publish` was still
unpinned. What is true now:

1. **`state/useKnowledge.publish.test.tsx` drives the real hook.** `react-dom/client`
   renders a harness into a fake container object, so no jsdom and no new dependency are
   needed. The harness returns `null`, which means react-dom never creates a host node. It
   only needs `addEventListener`, `tagName` and a `window` holding `HTMLIFrameElement`.
   `fetch` is stubbed, and a seeded taxonomy sits in a stubbed `localStorage`. The harness
   captures `actions` and every rendered `error`/`selected`, awaits `publish(...)` inside
   `act`, and asserts the settled state. `renderToStaticMarkup` could only have pinned the
   resolved value: a setState after the render is a no-op on the server, so the
   `setError(null)` mutant would be invisible there. Three tests:
   - a 200 `{outcome:"conflict", reason:"node_retired"}` resolves `false`, `error` is
     the `describeConflict` text, nothing is selected, and no refresh fetch is made
   - a 409 `{error:{code:"conflict", pointer}}` resolves `false` and `error` is
     `"conflict at /content/base_revision_id"`
   - control: a 200 `{outcome:"accepted"}` resolves `true`, `error` stays `null`, the
     node is selected and `getAcceptedHead` is fetched

   Each of the following was applied alone, run, and reverted with `git checkout HEAD`:

   | Mutant (in `useKnowledge.ts`) | Red lines |
   |---|---|
   | whole file reverted to `84061c9` | conflict test: `Expected: false` / `Received: true` (file 2 pass / 1 fail; `bun test src` **198 pass / 1 fail**) |
   | G at the call site: `interpretPublishResult({ ...result, body: null }, describe)` | conflict test: `Expected: false` / `Received: true`; 409 test: `Expected: "conflict at /content/base_revision_id"` / `Received: "HTTP 409"` (1 pass / 2 fail) |
   | F at the call site: `setError(interpreted.error)` -> `setError(null)` | conflict test: `Expected: "publish refused: this node was superseded or retired -- publishing here is disabled"` / `Received: null`; 409 test: `Received: null` (1 pass / 2 fail) |

   The whole-file revert keeps the `!result.ok` path, so the 409 test passing under it is
   expected. The conflict test is the one that sees the revert.
2. **Correction guard, relation half now pinned.** The verifier's mutant
   `built.entries.some((e) => e.relation === "corrects")` -> `built.entries.length > 0`
   survived. A new `citeCorrect.test.ts` case sends type `correction` with one `supports`
   URL link and expects the button disabled and `submit()` to refuse. Against the mutant
   it gives `Expected: true` / `Received: false` (14 pass / 1 fail). **Still open:** a
   `corrects` link whose target is a URL rather than a `node_revision` passes the guard,
   although the copy says "pointing at the revision this corrects". Tightening the guard
   would change behaviour, so it was left for a round that can re-run the browser proof.
3. **`CorrectForm.submitRef` removed.** It was a test-only seam that no test used.
4. **Round-2 report correction.** The round-2 report said the live probe ran "with all
   four commits already made". That was false. `.tmp/acceptor/live-probe/out/ui-cite2.md`
   recorded `Start HEAD: 3f4e537`, and the probe finished before commit `956ce82`. The
   verifier re-ran it at `188af50` and got the same results, so nothing functional
   changed, but the statement was wrong.
5. **No new screenshots this round.** No user-visible behaviour changed: the hook,
   `interpretPublishResult` and the guard logic are the same, and the new code is tests
   plus the removal of an unused prop. `38-cite2-01` still shows the pre-round-2
   `CORRECTION_NEEDS_LINK` wording.

Totals: `bun test src` (app/ui/v2) **200 pass, 0 fail** across 33 files. `tsc --noEmit`
is clean.
