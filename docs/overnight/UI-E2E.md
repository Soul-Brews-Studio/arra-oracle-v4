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
UI_E2E_DRIVER_BUDGET=900 bash app/just/ui-e2e.sh  # driver budget in seconds (default 600)
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
4. **Drive.** `ego-browser nodejs` drives the built UI through `ui-e2e/drive.mjs`, exactly
   once (see "Driver lifetime" below). Every step checks DOM state through `page.evaluate`
   and writes one verdict line to `OUT/transcript.txt`, which the script streams live and
   judges from.
5. **Teardown.** An EXIT trap always runs `ui-e2e/teardown.mjs`. It clears the origin's
   local and session storage with `Storage.clearDataForOrigin`, which is scoped to one
   origin and never touches the profile, and prints the key count before and after. It then
   closes the ego space and runs `demo_stack_down`, which stops the server and removes the
   mktemp root. The browser teardown counts only when it prints `after=0` **and**
   `TEARDOWN space … finished`; anything else is `STEP_FAIL browser-teardown` and exit 1.

Files:

| File | What it holds |
|---|---|
| `app/just/ui-e2e.sh` | the orchestrator: build, stack, CLI seed, driver, verdict, trap |
| `app/just/ui-e2e/drive.mjs` | `drive`: the entry point, run inside `ego-browser nodejs`. It opens one space, puts the token in localStorage (never in a URL), and runs `chain`, `verify`, `historicLabels` |
| `app/just/ui-e2e/chain.mjs` | `chain`: the writes, all made through the UI: seed vocab → create → revise → cite → correct → retire a citer → supersede |
| `app/just/ui-e2e/verify.mjs` | `verify`: the reads: evidence labels after the lifecycle writes, unresolved evidence, history byte-identity, chat, and Thai search |
| `app/just/ui-e2e/historicLabels.mjs` | `historicLabels`: a revision's label snapshot after `renameTerm` and two later edits |
| `app/just/ui-e2e/probes.mjs` | `probes`: the page-side DOM probes and the in-page API caller |
| `app/just/ui-e2e/harness.mjs` | `harness`: step verdicts, the transcript writer, deadline and lease checks, bounded retries, DOM polling, the form driver and screenshots |
| `app/just/ui-e2e/teardown.mjs` | `teardown`: clears the origin's storage, proves it empty, closes the space |
| `app/just/ui-e2e/{text,diffPair,need,nid}.mjs` | the typed fixtures, the diff-pair picker ops, the "missing from an earlier step" guard, the id generator |

## AC → step

| #33 AC | Step (verdict line) | What is asserted, read from the DOM |
|---|---|---|
| AC1 create | `create` | Clicking `new` and then `create node` opens the node from the route. The head `<h2>` is the typed title and the history is `#1` |
| AC1 revise | `revise` | After `publish revision` the head is the new title and the history is `#2,#1`. Revision 1's title and body are pinned from the rendered diff (DOM) and from `listAcceptedHistory` (raw row) |
| AC1 cite | `cite` | B is created with three links: `supports` → A#2 and `related_to` → A#1, both picked from the loaded-revision list, plus a `url` link. **DIRECT EVIDENCE** on B shows `links (3)`, badged `locator only · current head`, `locator only · stale: not head` and `locator only`. **REVERSE EVIDENCE** on A lists B and D, each badged `locator only · citing node current` |
| AC1 correct | `correct` | The Correct form on A (corrects `#2`) opens the new node C. C's direct evidence is a `corrects` row pointing at A#2, badged `current head` |
| AC1 explicit supersede | `retire-citing-node`, `supersede` | D is retired (`Retire…` → `Confirm retire` → `accepted`). A is superseded by C through `Supersede…` → `Confirm supersede` → `accepted`. On A's Knowledge view the banner reads `superseded` with `open successor: <C title>` linking to C. `fieldset.disabled`, `publish revision :disabled`, `record correction :disabled` and `title :disabled` are all true |
| AC1 history, AC3 historic title/body unchanged | `history-byte-identical` | After revise, cite, correct, retire and supersede, A's revision 1 still renders identically in the diff (from-title and from-body lines, compared with the snapshot pinned in `revise`). Its `title`, `body`, `term_snapshot_json`, `link_snapshot_json` and `content_digest` are byte-identical in `listAcceptedHistory`. **This step says nothing about labels:** A's rev 1 carries only the sealed `type:note`, which `renameTerm` refuses to rename, so its term bytes cannot change. The label half is the next row |
| AC3 historic labels unchanged | `history-labels-after-rename` | Node L is published through the HTTP API with `type:note` + an OPEN `topic:storage` term (the UI cannot attach a topic). Then `renameTerm storage → persistence`, rev 2 through the API with `topic:persistence` (the server demands the current name on new content), and rev 3 through the UI's publish form. In the DOM, the `#1` vs `#2` diff's term list is exactly `~ topic:storage → topic:persistence`, and `#1` vs `#3` contains `− topic:storage` and no `persistence`. Rev 1's `title`, `body`, `term_snapshot_json` and `content_digest` are byte-identical to what was read back right after it was published. A UI that rendered live labels would show `persistence` on rev 1's side and fail |
| AC3 stale/unavailable labelled | `cite`, `evidence-after-supersede`, `evidence-unresolved`, `evidence-target-unavailable` | See the label matrix below |
| AC1 peer-context chat | `chat-peer-context` | As alice in `daily-loop`: the answer is non-empty and the coverage badge reads `partial coverage`. The excluded list shows `unauthorized`. `items_used` is non-empty and every cited id is one of the two `daily-loop` messages the CLI seeded. The secret canary is absent from `document.documentElement.outerHTML`. With Ollama down this step prints `STEP_SKIP`, never OK |
| search (brief) | `search-thai-keyword` | B's head is indexed (`indexRevisionChunks`, the operator step) and `#/explore?tab=search&q=ลืม&mode=keyword` is opened. The route's `mode` is `keyword`, and B's hit (`Port conventions: อย่าหลงลืม`) is labelled with a rank (`#1`) and the match `ngram`, with no semantic `distance` |
| AC4 screenshots | `SHOT …` lines / `screenshot-*` verdicts | 13 PNGs per run. A missing or near-blank PNG is its own `STEP_FAIL screenshot-<name>` |

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

## Transcript (fix round, run 2, 2026-09-27 13:49)

This is the current script at `9566a22`. The browser painted no frames, so every
screenshot failed. Only the first `screenshot-*` failure is shown below; `screenshot-02` to
`screenshot-13` failed the same way, and each is its own `STEP_FAIL`. `SHOT`, `RETRY` and
`NOTE screenshot` lines are left out. Every DOM step passed, including the new
`history-labels-after-rename`, and the run correctly exits 1:

```text
== 1. build the v2 UI from app/ui/v2 into app/server/public/v2 ==
STEP_OK ui-build
== 2. fresh mktemp stack: target19 + legacy15 + dev policy ==
STEP_OK dataset-create
STEP_OK dev-policy
== 3. start the server through the writer gate on a free port (59255) ==
STEP_OK server-start
== 4. seed through the real CLI: 3 peers, 2 sessions, EN + Thai messages, a secret linked session ==
STEP_OK seed
== 5. drive the built UI with ego-browser (ui-e2e/drive.mjs) ==
E2E_START
E2E_SPACE 262
STEP_OK ui-open http://127.0.0.1:59255/v2/ (token set in localStorage, never in a URL)
STEP_OK ui-seed-vocab type + memory_horizon seeded from the UI
STEP_FAIL screenshot-01-created: CDP request timed out: Page.captureScreenshot
STEP_OK create node A=m9ruznwjeopJ2BgppNn6f rev #1
STEP_OK revise A #2=7sBZP-ny… history #2,#1; rev1 DOM snapshot pinned
STEP_OK cite B=rYQmMFj5Gmf-s4alKNvuC cites A#2 (current head), A#1 (stale: not head), url (locator only); A shows REVERSE rows for B and D
STEP_OK correct C=-1MRXwVCBwUrQ4OeXxJP9 (type correction) corrects A#2; C rev dWYE2wxc…
STEP_OK retire-citing-node D retired (accepted — lifecycle history refreshed )
STEP_OK supersede {"banner":"supersededopen successor: Test server port is 47779This node","fieldsetDisabled":true,"publishDisabled":true,"correctDisabled":true}
STEP_OK evidence-after-supersede B->A#2: target superseded/retired; B->A#1: stale: not head + target superseded/retired; A<-D: citing node superseded/retired; A<-B,C: citing node current
NOTE publishRevision with a dangling node_revision target -> 400 {"version":"arra-publication-error/v1","code":"invalid_reference","path":"/content/link_snapshot_json","message":"invalid scoped reference"}
STEP_OK evidence-unresolved E=HEK-gG3Tnk_CfWZGfJ2cS: url cited as unresolved -> badge "unresolved"
STEP_SKIP evidence-target-unavailable (unreachable through a real write: publishRevision -> 400 invalid_reference)
STEP_OK history-byte-identical rev 1 title/body identical in the DOM, and title, body, term_snapshot_json, link_snapshot_json, content_digest byte-identical in listAcceptedHistory, after revise, cite, correct, retire and supersede
STEP_OK chat-peer-context answer "[UhZkNgOdBeFahVXvq4ne] บอกว่าต้องถ่ายสำเนาดิสก์ก่อนซ้อมย้ายข้อมูลทุกครั้ง [Iikd0"…; partial coverage; citations 2 (all in…
STEP_OK search-thai-keyword ลืม -> "#1Port conventions: อย่าหลงลืมngramPort conventions: อย่าหลงลืม\n\nอย่าหลงลืมจองพอร์ตก่อนรันเทสต์ -- never forget t…
STEP_OK history-labels-after-rename L=teauzFFx7VRi8G6x6rEAV: after renameTerm storage->persistence and 2 later edits (API #2, UI #3), rev 1 renders topic:storage (#1 vs #2 "~ topic:storage → topic:persistence"; #1 vs #3 ["− topic:storage"]); rev 1 title…
E2E_SUMMARY failures=13 screenshots=0 failed=[screenshot-01-created,screenshot-02-revised-diff,screenshot-03-direct-evidence,screenshot-04-reverse-evidence,screenshot-05-correction-evidence,screenshot-06-superseded-writes-disabled,screenshot-07-direct-evide…
E2E_DRIVER_DONE
UI_E2E_RESULT FAIL ok=14 fail=13 skip=1 driver_rc=0
TEARDOWN origin http://127.0.0.1:59255 storage keys before=4 after=0
TEARDOWN space 262 finished {"spaceId":262,"closedSpace":true,"keptManagedLabels":[],"closedManagedLabels":["p1"],"preservedUnmanagedCount":0}
== 6. stop server and remove the mktemp stack ==
STEP_OK stack-down
```

## Transcript (run 6, previous round, 2026-09-27)

Run 6 used the previous round's driver, with the watchdog, before the label step
existed. It is kept because its screenshots are the committed ones.


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

### Fix round (2026-09-27, `bash app/just/ui-e2e.sh OUT`, full script including the build)

| Run | Wall clock | Result | Non-screenshot failures | Browser teardown |
|---|---|---|---|---|
| 1 | 13:38-13:48 | `UI_E2E_RESULT FAIL ok=13 fail=14 skip=1 driver_rc=0`, exit 1 | `history-labels-after-rename: driver deadline passed` | `before=4 after=0`, space 256 finished |
| 2 | 13:49-13:53 | `UI_E2E_RESULT FAIL ok=14 fail=13 skip=1 driver_rc=0`, exit 1 | none | `before=4 after=0`, space 262 finished |
| 3 | 13:53-13:57 | `UI_E2E_RESULT FAIL ok=14 fail=13 skip=1 driver_rc=0`, exit 1 | none | `before=4 after=0`, space 263 finished |
| 4 | 13:57-14:01 | `UI_E2E_RESULT FAIL ok=14 fail=13 skip=1 driver_rc=0`, exit 1 | none | `before=4 after=0`, space 264 finished |

Runs 2-4 are the three repeats. In each, all 14 DOM steps are `STEP_OK`, the only
`STEP_SKIP` is `evidence-target-unavailable`, and the 13 failures are the 13
`screenshot-*` verdicts. The browser painted no frames at any point in this round (see
"Honest limits"), so the runs **exit 1, as they must**. No run needed a teardown retry, and
afterwards `listTaskSpaces()` showed only the user-owned space 99, which predates this
work.

Run 1 used this round's harness before the one-attempt rule for screenshots existed.
Every screenshot took three 15 s timeouts, so the driver reached its 600 s deadline during
the last step. That step's `#1` vs `#2` label check had already passed; its screenshot and
its `#1` vs `#3` wait then printed `driver deadline passed`, and the driver still reached
`E2E_DRIVER_DONE`. That is the new deadline working as designed: a slow run ends as a
visible `STEP_FAIL`. It is not killed and restarted. Each driver took about 4 minutes,
well past the old 90 s watchdog, which would have killed every one of these runs.

### Previous round

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
box. In the fix round the likely cause turned up: `ego-browser nodejs` hands stdout
back only at exit (see "Driver lifetime"). `teardown.mjs` now appends its own lines to
`OUT/teardown.txt` as they happen, and the script makes up to 2 attempts. It accepts the
teardown only when the file shows `after=0` **and** `TEARDOWN space … finished`. The old
check accepted any `TEARDOWN space` line and never read the `after=` count. Anything else
prints `STEP_FAIL browser-teardown` and exits 1.

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
attempt died differently: it printed nothing for 8+ minutes, was killed, and exited 1
with `ok=0 fail=0`. At the time this was read as "`ego-browser nodejs` never opened a
space", and a driver-start watchdog was built on that reading. The silence is the
stdout-at-exit behaviour described in "Driver lifetime", so the watchdog has been removed.

**Label mutation (fix round).** This ran in a scratch worktree (`git worktree add
--detach`, since removed) holding this round's `app/just`. In
`app/ui/v2/src/components/RevisionDiff.tsx`, the relabelled line
`~ {termText(c.from)} → {termText(c.term)}` was changed to
`~ {termText(c.term)} → {termText(c.term)}`, so rev 1's side shows the later label
instead of its own snapshot. The script rebuilt the bundle from that source:

```text
NOTE the rebuilt bundle differs from the committed one: this run tests the working-tree UI source
STEP_OK history-byte-identical rev 1 title/body identical in the DOM, and title, body, term_snapshot_json, link_snapshot_json, content_digest byte-identical in listAcceptedHistory, after revise, cite, correct, retire and supersede
STEP_FAIL history-labels-after-rename: #1 vs #2 terms ["~ topic:persistence → topic:persistence"] != ["~ topic:storage → topic:persistence"]
E2E_DRIVER_DONE
UI_E2E_RESULT FAIL ok=13 fail=13 skip=1 driver_rc=0
TEARDOWN origin http://127.0.0.1:56231 storage keys before=4 after=0
```

The exit code was 1. `history-byte-identical` stayed `STEP_OK` under this mutation, as it
did under all three of the verifier's mutations. That is why the label half of AC3 now has
its own step. The other 12 failures in this run are the `screenshot-*` verdicts; see
"Screenshots depend on the ego window painting".

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

These twelve PNGs are from run 6, which used the previous round's driver. No screenshot
from the fix round is committed, because in every fix-round run the browser produced no
frames and each `screenshot-*` verdict was `STEP_FAIL`. The same failure appears in the
verifier's runs from 13:2x. So the new step's picture, `e2e-13-history-label-after-rename.png`
(the `#1` vs `#2` diff showing `~ topic:storage → topic:persistence`), does not exist yet. The
next run on a machine whose ego window is painting will write it to `OUT_DIR`.

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
- **Some writes do not go through the UI**, because the UI does not offer them:
  - the E citation with `capture_status: unresolved`
  - `indexRevisionChunks` for B, which search needs as a separate operator step (#30)
  - for the label check: `createVocabulary topic`, `createTerm storage`, L's revisions 1
    and 2, and `renameTerm`. The UI writes only the sealed `type` and `memory_horizon`
    terms and has no rename action.

  All of these use the page's own bearer to call the real HTTP API. L's third revision
  goes through the UI's publish form. The CLI seeds everything else that has no UI, such as
  sessions, memberships and the session link.
- **Screenshots are viewport captures, taken over raw CDP.** ego keeps a per-origin zoom,
  measured at 150% on `127.0.0.1`. Under that zoom, the SDK's `page.screenshot()` returned
  only the top-left 1/1.5 of the viewport: 711×445 of a 1067×667 CSS viewport, which cut
  off every right-hand panel, including the chat answer. The harness pins a 1600×1000
  metric, captures with `Page.captureScreenshot` and writes the PNG itself. Before each
  capture it scrolls the relevant heading to the top. The DOM assertions, not the pictures,
  are the verdict.
- **Browser plumbing retries are bounded and printed.** Each retry shows as a `RETRY …`
  line. Screenshot timeouts and near-blank PNGs get up to 3 attempts. Once one screenshot
  has timed out on every attempt, later ones get a single attempt, and each is still its
  own `STEP_FAIL`, so a browser that paints nothing cannot use up the whole budget. The
  184px viewport glitch gets 8 resets. Assertions are never retried until they pass:
  `waitDom` polls one condition to a deadline and fails there. **The driver itself is never
  restarted** (see "Driver lifetime").
- **Screenshots depend on the ego window painting.** On 2026-09-27, from about 13:20 (the
  verifier) and again from 13:38 (this round), `Page.captureScreenshot` and the SDK's
  `page.screenshot()` timed out even on a `data:` URL in a fresh space, while
  `requestAnimationFrame` and `Page.printToPDF` answered in milliseconds
  (`.tmp/red/shotprobe2.mjs`). The browser was not producing frames for the agent's space;
  the page was not at fault. The harness reports this as `STEP_FAIL screenshot-*`, and the
  run exits 1. It does not fall back to another kind of capture.
- **The token is never in a URL.** `drive.mjs` loads `/v2/`, writes the token into
  `localStorage` (the key `useToken` reads) and reloads. The space runs on the imported
  profile, and a `?token=` URL would otherwise end up in its history, which
  `Storage.clearDataForOrigin` does not clear.

## Driver lifetime (fix round, 2026-09-27)

The first version killed and restarted any driver that had not printed `E2E_SPACE` within
90 seconds. The verifier measured that premise to be false, and this round measured it
again with `.tmp/red/measure.sh`. That is an 8 s `ego-browser nodejs` script that prints
`E2E_SPACE early` and also appends the same line to a file itself:

```text
t=5s  stdout.txt bytes=0  selfwrite.txt bytes=16  (client alive: yes)
exit rc=0
after exit stdout.txt bytes=22  selfwrite.txt bytes=21
```

`ego-browser nodejs` 0.5.1.13 hands the script's stdout back only when the script exits,
and killing the client does not stop the script inside the ego service. So the watchdog
killed every driver that ran longer than 90 s, the killed script kept driving the same
server alongside the restart, and the restart truncated the transcript and re-ran every
assertion. A slow attempt's `STEP_FAIL`s could be thrown away and a later attempt could
print PASS.

The driver now works like this:

- **One attempt.** The driver runs exactly once. A new TaskSpace is never used to recover,
  which is also the ego-browser skill's rule.
- **It writes its own transcript.** The driver appends every line to `OUT/transcript.txt`
  with `appendFileSync`, including `E2E_START` before it opens the space and
  `E2E_SPACE <id>` after. The script streams that file with `tail -F`, so progress shows
  live.
- **It has a deadline.** `UI_E2E_DRIVER_BUDGET` defaults to 600 s. Once the deadline has
  passed, the step that is running and every later step print
  `STEP_FAIL … driver deadline passed`.
- **The verdict is fixed when the script stops waiting.** `timeout` (budget + 60 s) is
  only a backstop for a call stuck inside the ego SDK. When the driver exits, or the
  backstop fires, the script removes a lease file. From then on the driver writes nothing
  and aborts, closing its own space. The verdict is counted from `OUT/verdict.txt`, a copy
  of the transcript taken at that moment, so a straggler cannot add a line or a verdict
  after the run has been judged.

## Full green run, 22:09 on main `9435719` (2026-09-27)

The first fully green run of `app/just/ui-e2e.sh` (both segments, fresh screenshots): **`UI_E2E_RESULT PASS ok=28 fail=0 skip=1`**. It used a fresh gated stack, the built bundle from main, real local Ollama for chat, and `UI_E2E_NO_BUILD=1`. Ego lite's `Page.captureScreenshot` works again: it had been timing out all day, and after a CDP `Page.startScreencast` probe plain captures worked in a fresh space, so no restart of the user's ego lite was needed. The 13 PNGs in `ui/e2e-*.png` are **from this run**; they replace the earlier-round set, and `e2e-13` is new. The one SKIP is `evidence-target-unavailable`, which cannot be reached through a real write (`publishRevision` answers `400 invalid_reference`), so it is not credited.

```text
STEP_OK ui-open http://127.0.0.1:56826/v2/ (token set in localStorage, never in a URL)
STEP_OK ui-seed-vocab type + memory_horizon seeded from the UI
STEP_OK create node A=x-DNYI71TnzwZTIJTUsrg rev #1
STEP_OK revise A #2=QM1nmIxl… history #2,#1; rev1 DOM snapshot pinned
STEP_OK cite B=PtFzE-RrCeZxTgNsB2aTd cites A#2 (current head), A#1 (stale: not head), url (locator only); A shows REVERSE rows for B and D
STEP_OK correct C=JmA9JpAOzu3eyr9lRRHMp (type correction) corrects A#2; C rev 4nYpVO5S…
STEP_OK retire-citing-node D retired (accepted — lifecycle history refreshed )
STEP_OK supersede {"banner":"supersededopen successor: Test server port is 47779This node","fieldsetDisabled":true,"publishDisabled":true,"correctDisabled":true
STEP_OK evidence-after-supersede B->A#2: target superseded/retired; B->A#1: stale: not head + target superseded/retired; A<-D: citing node superseded/retired; A
STEP_OK evidence-unresolved E=biviOA-5Brj7eZyUL3sYh: url cited as unresolved -> badge "unresolved"
STEP_SKIP evidence-target-unavailable (unreachable through a real write: publishRevision -> 400 invalid_reference)
STEP_OK history-byte-identical rev 1 title/body identical in the DOM, and title, body, term_snapshot_json, link_snapshot_json, content_digest byte-identical in 
STEP_OK chat-peer-context answer "[0cKsELDLtuOgWQ6rTOv3X] บ็อบบอกว่าต้องทำการ snapshot ดิสก์ก่อนซ้อมย้ายข้อมูลทุกค"…; partial coverage; citations 2 (all in dail
STEP_OK search-thai-keyword ลืม -> "#1Port conventions: อย่าหลงลืมngramPort conventions: อย่าหลงลืม\n\nอย่าหลงลืมจองพอร์ตก่อนรันเทสต์ -- never forget to reser" 
STEP_OK history-labels-after-rename L=TomB4xYunWT8W_0qPDcZM: after renameTerm storage->persistence and 2 later edits (API #2, UI #3), rev 1 renders topic:storag
STEP_OK keys-start #/overview reloaded, focus on <body>
STEP_OK keys-view-tabs Tab x5 to the view tablist; ArrowRight/End/Home/ArrowLeft move focus only; Enter opened explore
STEP_OK keys-open-peer Tab x6 to row alice; ArrowDown -> bob, ArrowUp back; Enter opened it (aria-current=true)
STEP_OK keys-open-session Tab x6 to row daily-loop; Space opened it
STEP_OK keys-detail-tabs Tab x2 to the detail tablist; End/Home/ArrowRight x3 then Enter -> messages tabpanel
STEP_OK keys-send-message Tab x3 to the composer; typed + Control+Enter; "keyboard hello HZ-n2V" is in the transcript
STEP_OK keys-open-knowledge Shift+Tab x17 back to the view tablist; End + Enter -> knowledge; vocab already seeded
STEP_OK keys-publish-and-revise A=w2Juu9rkn1Ljub4kTY66T created then revised to #2; focus after create: H2:Keyboard node HZ-n2V, after revise: H2:Keyboard node 
STEP_OK keys-cite B=dceVu25fFmibZfWI3RkAD cites A#2 (VORQbgsz…), picked by type-ahead "#2 — Keyboard node HZ-n2V v2 ("
STEP_OK keys-correct Shift+Tab x4 to A in the node rail, Enter -> focus on A's <h2>; C=aItz4ZHhr54IunIW9irdZ corrects A#2; focus now H2:Keyboard correction HZ-n
STEP_OK keys-supersede A superseded by C (_Cq5xqaK…) from Explore > evidence, ids typed
STEP_OK keys-read-history knowledge opened, focus stayed on the knowledge tab; Tab x22 to history #1, Enter -> diff from rev 1 "Keyboard node HZ-n2V"
STEP_OK keys-narrow-812x375 {"explore":{"vw":812,"vh":375,"docScroll":709,"overflowX":false,"pane":{"top":0,"bottom":376,"h":375},"tablist":{"top":0,"bottom":37
STEP_OK keys-stale-tab #/explore?peer=alice&session=daily-loop&tab=Nodes: one tab stop (explore-detail-tab-nodes), reached by Tab x19 with nodes selected; Arrow
```

Teardown: the server was stopped, the mktemp root removed, the origin's localStorage cleared and the ego space finished (`.tmp/e2e-full/teardown.txt`).
