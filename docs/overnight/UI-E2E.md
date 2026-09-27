# UI end-to-end test for #33 (AC1, AC3, AC4)

`app/just/ui-e2e.sh` is a repeatable browser test of the built v2 UI. It runs against a real
gated server on a fresh `mktemp -d` dataset and makes real API writes, with no mocks and no
stubbed model. Branch `v4/on-ui-e2e-script`, base `883fca7`. It changes nothing under
`app/ui/v2` or `app/server/src`. Rulings: `docs/overnight/DECISIONS.md` R12 and the #33 gap
the acceptor left open.

## How to run it

```bash
bash app/just/ui-e2e.sh [OUT_DIR]          # screenshots + transcript.txt land in OUT_DIR
UI_E2E_NO_BUILD=1 bash app/just/ui-e2e.sh  # test the bundle already in app/server/public/v2
```

It needs `ego-browser` on `PATH`. For chat it also needs local Ollama with `gemma3:4b`. The
script exits 0 only when every step prints `STEP_OK` or `STEP_SKIP` and the driver reaches
`E2E_DRIVER_DONE`. Any `STEP_FAIL` exits 1, and so does a driver that dies part way.

What it does, in order:

1. **Build.** Runs `vite build` from `app/ui/v2` into `app/server/public/v2`, so a change to
   the UI source is what gets tested. On an unchanged tree the output is byte-identical to
   the committed bundle and `git status` stays clean. If the bundle differs from the
   committed one, the script prints a NOTE.
2. **Stack.** Calls `demo_stack_up` from `app/just/demo/stack.sh`, exactly as `demo.sh`
   does. That creates target19 + legacy15 datasets under `mktemp -d`, writes a dev policy
   and token, and starts the server through the writer gate on a free port.
3. **Seed.** Everything here goes through the real CLI (`bun app/cli.ts`):
   - peers `alice`, `bob` and `carol`
   - sessions `daily-loop` (alice + bob) and `secret-room` (carol only)
   - an English and a Thai (`อย่าหลงลืม…`) message in `daily-loop`
   - a `SECRET-CANARY-<random>` message in `secret-room`
   - `createSessionLink daily-loop → secret-room`

   Alice is not a member of `secret-room`. Her chat context is therefore partial, and the
   canary must never reach the page.
4. **Drive.** `ego-browser nodejs` drives the built UI through `ui-e2e/drive.mjs`. Every
   step checks DOM state through `page.evaluate` and prints one verdict line.
5. **Teardown.** An EXIT trap always runs `ui-e2e/teardown.mjs`. It clears the origin's
   local and session storage with `Storage.clearDataForOrigin`, which is scoped to one
   origin and never touches the profile, and prints the key count before and after. It then
   closes the ego space and runs `demo_stack_down`, which stops the server and removes the
   mktemp root.

Files:

| File | What it holds |
|---|---|
| `app/just/ui-e2e.sh` | the orchestrator: build, stack, CLI seed, driver, verdict, trap |
| `app/just/ui-e2e/drive.mjs` | the entry point, run inside `ego-browser nodejs`. It opens one space and runs the chain and then the verify steps |
| `app/just/ui-e2e/chain.mjs` | the writes, all made through the UI: seed vocab → create → revise → cite → correct → retire a citer → supersede |
| `app/just/ui-e2e/verify.mjs` | the reads: evidence labels after the lifecycle writes, unresolved evidence, history byte-identity, chat, and Thai search |
| `app/just/ui-e2e/probes.mjs` | the page-side DOM probes and the in-page API reader |
| `app/just/ui-e2e/harness.mjs` | step verdicts, bounded retries, DOM polling, the form driver and screenshots |
| `app/just/ui-e2e/teardown.mjs` | clears the origin's storage and closes the space |

## AC → step

| #33 AC | Step (verdict line) | What is asserted, read from the DOM |
|---|---|---|
| AC1 create | `create` | Clicking `new` and then `create node` opens the node from the route. The head `<h2>` is the typed title and the history is `#1` |
| AC1 revise | `revise` | After `publish revision` the head is the new title and the history is `#2,#1`. Revision 1's title and body are pinned from the rendered diff (DOM) and from `listAcceptedHistory` (raw row) |
| AC1 cite | `cite` | B is created with three links: `supports` → A#2 and `related_to` → A#1, both picked from the loaded-revision list, plus a `url` link. **DIRECT EVIDENCE** on B shows `links (3)`, badged `locator only · current head`, `locator only · stale: not head` and `locator only`. **REVERSE EVIDENCE** on A lists B and D, each badged `locator only · citing node current` |
| AC1 correct | `correct` | The Correct form on A (corrects `#2`) opens the new node C. C's direct evidence is a `corrects` row pointing at A#2, badged `current head` |
| AC1 explicit supersede | `retire-citing-node`, `supersede` | D is retired (`Retire…` → `Confirm retire` → `accepted`). A is superseded by C through `Supersede…` → `Confirm supersede` → `accepted`. On A's Knowledge view the banner reads `superseded` with `open successor: <C title>` linking to C. `fieldset.disabled`, `publish revision :disabled`, `record correction :disabled` and `title :disabled` are all true |
| AC1 history, AC3 historic body unchanged | `history-byte-identical` | After revise, cite, correct, retire and supersede, revision 1 still renders identically in the diff (from-title, from-body lines and term section, compared with the snapshot pinned in `revise`). Its `title`, `body`, `term_snapshot_json` (the label snapshot), `link_snapshot_json` and `content_digest` are byte-identical in `listAcceptedHistory` |
| AC3 stale/unavailable labelled | `cite`, `evidence-after-supersede`, `evidence-unresolved`, `evidence-target-unavailable` | See the label matrix below |
| AC1 peer-context chat | `chat-peer-context` | As alice in `daily-loop`: the answer is non-empty and the coverage badge reads `partial coverage`. The excluded list shows `unauthorized`. `items_used` is non-empty and every cited id is one of the two `daily-loop` messages the CLI seeded. The secret canary is absent from `document.documentElement.outerHTML`. With Ollama down this step prints `STEP_SKIP`, never OK |
| search (brief) | `search-thai-keyword` | B's head is indexed (`indexRevisionChunks`, the operator step) and `#/explore?tab=search&q=ลืม&mode=keyword` is opened. The hit list contains B, `Port conventions: อย่าหลงลืม`, with match `ngram` |
| AC4 screenshots | `SHOT …` lines / `screenshot-*` verdicts | 12 PNGs per run. A missing or near-blank PNG is its own `STEP_FAIL screenshot-<name>` |

### Evidence label matrix (from `directEvidenceLabels.ts` / `reverseEvidenceLabels.ts`)

| Label | Reached? | How |
|---|---|---|
| `locator only` | yes | every link the UI's editor writes (`buildLinkSnapshot` always sets `locator_only`) |
| `unresolved` | yes | E is published through the real HTTP API with a `url` link whose `capture_status` is `unresolved`. The UI editor cannot write this status |
| `current head` | yes | B → A#2 before the supersede, and C → A#2 |
| `stale: not head` | yes | B → A#1 once A has #2 |
| `target superseded/retired` | yes | B → A#2 and B → A#1 after A is superseded |
| `citing node current` | yes | A ← B and A ← C |
| `citing node superseded/retired` | yes | A ← D after D is retired |
| `target unavailable` | **no, `STEP_SKIP`** | This label needs a `node_revision` citation to a revision the server does not hold. `publishRevision` refuses exactly that with `400 invalid_reference /content/link_snapshot_json`, even with `capture_status: unresolved`. Revisions are never deleted, so no real write reaches it. The script tries the write, prints the refusal as a `NOTE`, and skips |
| `historical citing revision` | no | `scanDependents` current mode always returns `is_snapshot_head: true` (see its own comment) |
| `checking…`, `… not checked`, `… status unknown`, `target lifecycle unknown` | no | These need a lookup to fail or to be in flight. The test waits until no `checking…` badge remains before it judges |

## Transcript (run 6, 2026-09-27)

```text
== 5. drive the built UI with ego-browser (ui-e2e/drive.mjs) ==
E2E_SPACE 239
STEP_OK ui-open http://127.0.0.1:50160/v2/ (token moved to localStorage, stripped from the URL)
STEP_OK ui-seed-vocab type + memory_horizon seeded from the UI
STEP_OK create node A=BlIiPX8fkgZAZMhpmSxkR rev #1
STEP_OK revise A #2=xUjdS4qw… history #2,#1; rev1 DOM snapshot pinned
STEP_OK cite B=0tn4B-t67t0aALsjlZTjX cites A#2 (current head), A#1 (stale: not head), url (locator only); A shows REVERSE rows for B and D
STEP_OK correct C=V9OyCE405C5bEiEfj9-gb (type correction) corrects A#2; C rev bahoiO_N…
STEP_OK retire-citing-node D retired (accepted — lifecycle history refreshed )
STEP_OK supersede {"banner":"supersededopen successor: Test server port is 47779This node","fieldsetDisabled":true,"publishDisabled":true,"correctDisabled":true}
STEP_OK evidence-after-supersede B->A#2: target superseded/retired; B->A#1: stale: not head + target superseded/retired; A<-D: citing node superseded/retired; A<-B,C: citing node current
NOTE publishRevision with a dangling node_revision target -> 400 {"version":"arra-publication-error/v1","code":"invalid_reference","path":"/content/link_snapshot_json","message":"invalid scoped reference"}
STEP_OK evidence-unresolved E=zf2DdbEXloND3YHePhWIb: url cited as unresolved -> badge "unresolved"
STEP_SKIP evidence-target-unavailable (unreachable through a real write: publishRevision -> 400 invalid_reference)
STEP_OK history-byte-identical rev 1 title/body/terms identical in the DOM and in listAcceptedHistory (title, body, term_snapshot_json, link_snapshot_json, content_digest) after revise, cite, correct, retire and supersede
STEP_OK chat-peer-context answer "ต้องทำการ snapshot ดิสก์ก่อนซ้อมย้ายข้อมูลทุกครั้ง [PtaFib8JzYpw4BXMDAkmD]."…; partial coverage; citations 2 (all in daily-loop); secret canary absent from the DOM
STEP_OK search-thai-keyword ลืม -> "#1Port conventions: อย่าหลงลืมngramPort conventions: อย่าหลงลืม\n\nอย่าหลงลืมจองพอร์ตก่อนรันเทสต์ -- never forget to reser"
E2E_SUMMARY failures=0 screenshots=12
E2E_DRIVER_DONE
UI_E2E_RESULT PASS ok=13 fail=0 skip=1
```

The `SHOT …` lines between verdicts are left out above. Before the driver, the run printed
`STEP_OK` for `ui-build`, `dataset-create`, `dev-policy`, `server-start` and `seed`. After
it came `STEP_OK stack-down`. Run 6's browser teardown failed silently; see "Teardown
finding" below.

## Repeat runs

| Run | Driver code | Result |
|---|---|---|
| 3 | final driver; old screenshot call, old trap | `UI_E2E_RESULT PASS ok=13 fail=0 skip=1`; `TEARDOWN … storage keys before=4 after=0` |
| 4 | same as run 3 | `UI_E2E_RESULT PASS ok=13 fail=0 skip=1`; `TEARDOWN … before=4 after=0` |
| 5 | same as run 3 | `UI_E2E_RESULT PASS ok=13 fail=0 skip=1`; `TEARDOWN … before=4 after=0` |
| 6 | final driver, CDP screenshots, driver-start watchdog | `UI_E2E_RESULT PASS ok=13 fail=0 skip=1`; browser teardown printed nothing |
| 7 | same as run 6 | `UI_E2E_RESULT PASS ok=13 fail=0 skip=1`; browser teardown printed nothing |
| 8 | same as run 6 | `UI_E2E_RESULT PASS ok=13 fail=0 skip=1`; browser teardown printed nothing |
| 9 | final script (retried teardown, stdin detached) | `UI_E2E_RESULT PASS ok=13 fail=0 skip=1`; `TEARDOWN origin … storage keys before=4 after=0`; `TEARDOWN space 243 finished … closedSpace:true` on the first attempt, with no `RETRY` |

Every run's only `STEP_SKIP` is `evidence-target-unavailable`. It is the same in all of
them, and the reason is explained in the matrix above.

**Teardown finding.** From run 6 on, the trap's `ego-browser nodejs … | rg` teardown
printed nothing, and runs 6-8 (and mutation run 2) left their ego space open with the
dev token in that origin's localStorage. The verdicts were not affected: the stack
teardown still ran, and the server and mktemp root were removed. I closed those four
spaces by hand (234, 239, 240, 241), each with `Storage.clearDataForOrigin` on its origin
and then `finish({ keep: [] })`. The same teardown code, run directly, answered in 0.24s
with `before=4 after=0`, so the root cause inside the trap was not identified in the time
box. The script now runs the teardown up to 3 times, writes its output to
`OUT/teardown.txt` rather than a pipe, and detaches stdin. If no attempt prints
`TEARDOWN space … finished`, it prints `STEP_FAIL browser-teardown` and exits 1.

## Mutation check

In `app/ui/v2/src/api/knowledge.ts`, `link_snapshot_json: JSON.stringify(input.links)` was
changed back to `link_snapshot_json: "[]"` (the pre-#113 bug). The script was then run
unchanged; it rebuilds the bundle from source and prints
`NOTE the rebuilt bundle differs from the committed one`. Result (mutation run 2):

```text
STEP_OK create node A=VTzjCZJIBzyExRBv1m6gk rev #1
STEP_OK revise A #2=ldH01gWr… history #2,#1; rev1 DOM snapshot pinned
STEP_FAIL cite: B direct evidence settled: not reached within 20000ms; last=false
STEP_FAIL correct: C corrects link: not reached within 20000ms; last=false
STEP_FAIL supersede: missing C1 (an earlier step failed)
STEP_FAIL evidence-after-supersede: B evidence rows: not reached within 20000ms; last=false
E2E_SUMMARY failures=4 screenshots=6 failed=[cite,correct,supersede,evidence-after-supersede]
UI_E2E_RESULT FAIL ok=9 fail=4 skip=1 driver_rc=0
```

The exit code was 1. Afterwards the source and `app/server/public/v2` were restored with
`git checkout` and `git clean`, and `git status` showed neither. The first mutation
attempt died differently: `ego-browser nodejs` never opened a space in 8+ minutes. It
was killed, and it exited 1 with `ok=0 fail=0`. That is why the driver-start watchdog
exists.

## Screenshots (run 6)

| File | Shows |
|---|---|
| `ui/e2e-01-created.png` | node A after `create node`: head #1 |
| `ui/e2e-02-revised-diff.png` | A after `publish revision`, with the #1 → #2 diff |
| `ui/e2e-03-direct-evidence.png` | B's DIRECT EVIDENCE: `current head` and `stale: not head` |
| `ui/e2e-04-reverse-evidence.png` | A's REVERSE EVIDENCE: B and D, `citing node current` |
| `ui/e2e-05-correction-evidence.png` | C's `corrects` link to A#2 |
| `ui/e2e-06-superseded-writes-disabled.png` | A's `superseded` banner and successor link, with the write forms disabled |
| `ui/e2e-07-direct-evidence-after-supersede.png` | B's links labelled `target superseded/retired` |
| `ui/e2e-08-reverse-evidence-after-supersede.png` | A ← D `citing node superseded/retired` |
| `ui/e2e-09-unresolved-evidence.png` | E's `unresolved` url citation |
| `ui/e2e-10-history-rev1-unchanged.png` | A's history and the #1 → #2 diff after every later write |
| `ui/e2e-11-chat-partial-coverage.png` | alice's answer, `partial coverage`, `unauthorized`, `items_used` |
| `ui/e2e-12-search-thai-keyword.png` | the `ลืม` keyword search finding `อย่าหลงลืม` |

## Defects found

- **The revision diff picker does not follow a revise done in place.** Repro: Knowledge →
  `new` → `create node` → fill the form again → `publish revision`. The diff row then shows
  `#1 — … vs #1 — …` and the text "pick two different revisions to diff", until the page is
  reloaded or both selects are set by hand. The cause is in `KnowledgeView.tsx`: the effect
  that defaults the pair "to the two newest" only replaces ids that are no longer in the
  history. After the first revise, the old `#1`/`#1` pair is still valid, so it is kept.
  This test picks the pair explicitly (`DIFF_1_VS_2`), as a reader would, and does not
  depend on the default. The UI was not changed: other slices are editing it tonight.
- **Not a defect, recorded so nobody chases it:** `target unavailable` cannot be reached
  through any real write (see the matrix above). The UI's label exists for data written
  some other way, for example imported rows.

## Honest limits

- **Local only.** `ego-browser` is not in CI, so this test is not part of `ci.yml`. It is
  run by hand and by the verifier.
- **Real Ollama for chat.** The chat step talks to local Ollama `gemma3:4b` through the
  server. The answer text varies from run to run. The assertions are structural: non-empty
  answer, `partial coverage`, `unauthorized` in the excluded list, citations restricted to
  the peer's own session, and the canary absent from the page. With Ollama down the step is
  `STEP_SKIP`.
- **Form input is event-level, not keystrokes.** Values are set through the native value
  setters, then the `input`/`change` event React listens to is dispatched and buttons are
  `.click()`ed. The React handlers, the API calls and the server are all real. Native
  keyboard and mouse delivery is not what this test exercises.
- **Two writes do not go through the UI**, because the UI does not offer them: the E
  citation with `capture_status: unresolved`, and `indexRevisionChunks` for B, which
  search needs as a separate operator step (#30). Both use the page's own bearer to call
  the real HTTP API. The CLI seeds everything that has no UI, such as sessions,
  memberships and the session link.
- **Screenshots are viewport captures, taken over raw CDP.** ego keeps a per-origin zoom,
  measured at 150% on `127.0.0.1`. Under that zoom, the SDK's `page.screenshot()` returned
  only the top-left 1/1.5 of the viewport: 711×445 of a 1067×667 CSS viewport, which cut
  off every right-hand panel, including the chat answer. The harness pins a 1600×1000
  metric, captures with `Page.captureScreenshot` and writes the PNG itself. Before each
  capture it scrolls the relevant heading to the top. The DOM assertions, not the pictures,
  are the verdict.
- **Browser plumbing retries are bounded and printed.** Each retry shows as a `RETRY …`
  line. Screenshot timeouts and near-blank PNGs get up to 3 attempts; the 184px viewport
  glitch gets 8 resets. A driver that has not printed `E2E_SPACE` within 90s is killed and
  started again, up to 3 attempts. This covers a measured hang inside `taskSpace()` (one
  start sat for 8+ minutes with no output). Before `E2E_SPACE` nothing has been asserted and
  no browser state exists; after it the run is never restarted. Assertions are never
  retried until they pass. `waitDom` polls one condition to a deadline and fails there.
