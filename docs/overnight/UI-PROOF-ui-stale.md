# UI proof: ui-stale (#33 AC1 supersede flow, R12)

Branch `v4/on-ui-stale`, based on `v4/on-ui-cite2` (48665d3). UI only: nothing under
`app/server/src` changed, and no contract under `app/docs/contracts/` changed, so no
contract amendment was needed.

## The bug

An independent verifier followed LifecycleBanner's "open successor" link from a superseded
node B. On 2 of 3 attempts the Knowledge view showed successor S2's id with B's title and
body. A reload showed S2 correctly. The fetch log showed B's `getAcceptedHead` and
`listAcceptedHistory` firing again alongside S2's, and whichever response arrived last won.

The diagnosis held up. There were two causes, and each is needed for the symptom:

1. `useKnowledge.refresh` wrote every response it received, even one for a node that was
   no longer selected.
2. `App.tsx` passed `bank={{ ... }}`, a new object on every render, and `refresh` depended
   on `[b, selected]`. The click on the link changes the route, which re-renders App. That
   rebuilt `refresh` while `selected` was still B, so B was fetched a second time, and
   that extra request could land after S2's.

## The fix

| File | Change |
|---|---|
| `app/ui/v2/src/state/useKnowledge.ts` | `refresh` increments a `gen` ref and checks it again after each `await` (head, then history). A response for a superseded selection or bank is dropped before any `setState`. The hook also reads the bank through `useStableBank`. |
| `app/ui/v2/src/state/useStableBank.ts` (new) | `useMemo` keyed on `bank`, `token` and `workspace`, so equal banks give one object. |
| `app/ui/v2/src/App.tsx` | One `bank` object from `useStableBank`, passed to Overview, Explore and Knowledge in place of three inline literals. |
| `app/ui/v2/src/state/useMemory.ts` | Audit finding: `refreshMessages` and `refreshContext` get generation guards. |
| `app/ui/v2/src/state/useListing.ts` | Audit finding: the cursor list's `load` gets a generation guard. |
| `app/ui/v2/src/state/writableHead.ts` | Comment only. Its claim that "`refresh` has no stale-response guard" stopped being true. It remains the write-side fence for the window before the new node's first answer. |

## Failing-first, through the real hooks

The harness is the same one `useKnowledge.publish.test.tsx` uses: `react-dom/client` renders
into a fake container, with stubbed `fetch` and `localStorage`, and no new dependency. The
new `fetch` stub holds every request until the test answers it, so the test controls which
node's response lands last.

### `src/state/useKnowledge.stale.test.tsx`, on the unfixed hook (48665d3): 0 pass / 3 fail

```
(fail) ... > B's head and history answering AFTER S2's leave S2 on screen
    expect(k.head?.revision?.node_id).toBe(S2);
    Expected: "nodeS2S2S2S2S2S2S2S2S"
    Received: "nodeBBBBBBBBBBBBBBBBB"
(fail) ... > B's history answering after S2 was selected does not replace S2's
    expect(k.history.map((r) => r.node_id)).toEqual([S2]);
    -   "nodeS2S2S2S2S2S2S2S2S",
    +   "nodeBBBBBBBBBBBBBBBBB",
(fail) ... > re-rendering with a NEW but equal bank object issues no request
    - []
    + [ "getAcceptedHead(nodeS2S2S2S2S2S2S2S2S)" x3 ]
 0 pass
 3 fail
```

With the fix: 3 pass, 0 fail.

### Mutants: each guard is pinned by its own test

| Mutant (applied to the fixed `useKnowledge.ts`) | Result |
|---|---|
| M1: drop the guard after `getAcceptedHead` | "B's head … AFTER S2's" fails (2 pass / 1 fail) |
| M2: drop the guard after `listAcceptedHistory` | "B's history … after S2" fails (2 pass / 1 fail) |
| M3: `const b = bank` (no `useStableBank`) | "NEW but equal bank … no request" fails (2 pass / 1 fail) |
| M4: `const g = gen.current` (never bumped) | both race tests fail (1 pass / 2 fail) |

After each mutant the file was restored, and `diff` confirmed it matched the fix.

### Audit: `src/state/staleReads.audit.test.tsx`, on the unfixed hooks: 0 pass / 3 fail

```
(fail) useMemory ... > session A's transcript answering after B's leaves B's on screen
    -   "mB",   +   "mA",
(fail) useMemory ... > session A's context answering after B's leaves B's on screen
    -   "cB",   +   "cA",
(fail) useListing ... > the pre-toggle listNodes page answering last does not replace the history view
    -   "with-history",   +   "ordinary",
```

With the fix: 3 pass, 0 fail. The red run used the unfixed `useMemory.ts` and
`useListing.ts` from HEAD, and each of those files adds only its guard. So the red run
also serves as the "drop the guard" mutant for each of these tests.

## Audit of every fetch-in-effect hook and panel

I found these with `rg -l useEffect app/ui/v2/src` plus `rg "await |\.then\("`.

| Hook / site | Finding | Action |
|---|---|---|
| `useKnowledge.refresh` (and `publish`'s own refresh) | No guard, last response wins (**the bug**). Keyed on bank identity. | Fixed. Keyed guard (`useKeyedRead`, round 3) plus `useStableBank` inside the hook |
| `App.tsx` bank prop | New object per render, fed to Overview, Explore and Knowledge | Fixed (`useStableBank`). **Not pinned by any test**; see "Round 3" below |
| `useMemory.refreshMessages` / `refreshContext`, and `send` / `join` that call them | No guard at base. Round 2's counter guard was wrong for `send`/`join`: they called a refresh bound at click time, so sA's read beat sB's | Fixed in round 3 (keyed guard; the refresh reads the session on screen) |
| `useListing` → `useCursorList.load`, `refreshAll` | No guard at base. `refreshAll` has always been frozen at the first render, so a workspace switch (and the refresh-all button) re-read the FIRST workspace. Round 2's counter did not fix that | Fixed in round 3 (keyed guard; `load` reads the current `fetchPage`; `refreshAll` is built from the stable per-list refreshes) |
| `useEvidenceReview` (trace, session links, lifecycle, association + dependents, every load-more) | Had a counter per lane. `applyLifecycleWrite` called a `refreshLifecycle` bound at click time, so node A's lifecycle rows and write outcome landed under node B. Its `refresh*` callbacks still depend on `b` identity, so an unstable bank still refetches the panels (wasted requests only) | Fixed in round 3 (keyed guard per lane; writes moved to `useLifecycleWrites`, which drops A's outcome under B) |
| `useNodeLifecycle` (LifecycleBanner's source) | Counter guard inside a `useEffect`. Every read is issued by the effect for that render's node, and nothing calls it from a stale closure | No change |
| `useEvidenceStatus` | Counter guard per lane inside `useEffect`s, keyed on the rows objects. No imperative caller | No change |
| `useKnowledgeSearch` | Request id + debounce. `run` fires only from its own effect's timer | No change |
| `useOverview` | Volley id. `refresh` is rebuilt per bank and the button reads the current one; `OverviewView` memoises the bank itself | No change |
| `useCiteTargets`, `useRoute`, `useToken` | No fetch | No change |
| `KnowledgeView` / `ExploreView` effects | Route → hook-state sync only, no fetch | No change |
| `useMemory.ask`, `verify`/`verifyAll`, `useKnowledge.actions.seed`, `WorkspaceBar.ping` | User-triggered actions, not reads. A switch while one is in flight can still land its result in the new selection or scope. Examples: `seed`'s taxonomy ids saved under a newly chosen bank, or a chat answer shown beside a different session | **Not fixed.** Listed as an open risk |

## Live proof (fresh gated stack, ego-browser)

**Stack.** `.tmp/ui-stale-stack.sh` is built from `app/just/demo/stack.sh`
(`demo_stack_up`/`demo_stack_down`) and `loop.sh`'s `build_publish_request`. It creates a
target19 dataset, a dev policy and token, and a writer-gated server, all under a fresh
`mktemp -d`. Through the CLI it ran `peer add`, `session add`, `joinSession` and
`seedReservedVocabularies`. It then published B ("B: the superseded node (old title)") and
S2 ("S2: the successor node (new title)"), and ran `supersedeNode(B → S2)`. All three
returned `accepted`.

**Browser.** ego-browser, space 249, one page. `Network.emulateNetworkConditions` set 150 ms
latency through `page.cdp`. An in-page `fetch` wrapper logged every knowledge call.

**Procedure.** Each run made 10 attempts. Each attempt opened B, clicked the real
"open successor" link, waited until nothing was in flight, then read three things: the id
span's `title`, the headings, and whether the body text contains "S2 BODY" or "B BODY".

**Two modes, both built to make B's answers land LAST:**

- **settle.** B is opened and fully loaded. Then any request naming B is delayed a further
  400–900 ms, and the link is clicked. This is the verifier's scenario: the only B request
  after the click would be the App-re-render refetch.
- **hold.** B's own `getAcceptedHead`/`listAcceptedHistory` are held for 900–1400 ms. The
  link is clicked as soon as the banner shows, while B's read is still in flight
  (`heldAtClick` = 1 on attempts 2–10). This exercises guard (1) directly.

**Control runs.** For both modes I also swapped in the unfixed bundle
(`git checkout -- app/server/public/v2`, i.e. 48665d3's `index-CMLtN5OH.js`), then rebuilt.

| Bundle | Mode | Attempts showing S2's id **and** title **and** body | B head/history requests fired after the click |
|---|---|---|---|
| fixed (`index-9YwOro3f.js`) | settle | **10 / 10** | 0 in every attempt (the refetch is gone) |
| fixed | hold | **10 / 10** | none new. B's held read (1.1–1.5 s) landed after S2's and was dropped |
| unfixed (`index-CMLtN5OH.js`) | settle | 0 / 10 | 4 per attempt (B's head + history, twice) |
| unfixed | hold | 0 / 10 | 4–6 per attempt |

**What the failures looked like.** Every failed attempt showed the verifier's symptom
exactly: the URL and id span were S2's (`#/knowledge?node=XU7WF5faVJ…`, id
`XU7WF5faVJ…`), but the heading was "B: the superseded node (old title)" and the body was
B's.

**What the fixed attempts looked like.** Every one showed the heading "S2: the successor
node (new title)" and S2's body, with no B heading and no B body.

**Rate.** The verifier saw the bug on 2 of 3 attempts. Here it failed every time on the
unfixed bundle, because the in-page delay forces the losing order. With natural timing
the failure rate depends on which response happens to arrive last.

**Raw results.** `.tmp/ui-stale-{fixed,old}-{settle,hold}.json` in the worktree, which is
git-ignored and not committed. The script is `.tmp/ui-stale-proof.mjs`.

**No screenshot.** `Page.captureScreenshot` timed out in this ego-browser session, both
through `page.screenshot()` and through raw CDP. So no image was committed for this
slice. The DOM reads above are the evidence.

**Teardown.**

- `ui-stale-stack.sh down` sent `kill -TERM` to the server pid. `kill -0` afterwards gave
  "no such process".
- The same step ran `rm -rf` on the mktemp root. `ls` afterwards gave "No such file or
  directory".
- The origin's localStorage went from 3 keys (`arra-ui-v2-nodes:default:default`,
  `arra-ui-v2-token`, `arra-ui-v2-roster:default`) to 0. sessionStorage was already 0 and
  was cleared anyway.
- The ego-browser space was finished with `keep: []`.

## Other checks

- `bun test src` (app/ui/v2): 206 pass, 0 fail, 35 files. This includes the 6 new tests.
- `./node_modules/.bin/tsc -p tsconfig.json` (app/ui/v2, the CI step): exit 0.
- `bun run typecheck` (app/server): exit 0.
- Python architecture guard (`app/migrate-py`, `unittest discover -s tests`): 269 tests,
  `OK (skipped=1)`. No TS file imports the publication kernel.
- Acceptor live probe (`run.sh … ui-stale`) reported:
  - 57 methods, each exposed over HTTP, MCP and CLI
  - isolation 191 pass / 0 fail
  - 26 payload gaps, 0 seed errors, fatal none
  - exit code 2, which the probe returns whenever payload gaps exist
- The probe's gaps are missing fixtures in the probe itself. This slice changes nothing on
  the server.

## Fix round (2026-09-27): the guards latched `loading`

An independent verifier refuted the first round, and the finding was correct. The new
generation bump drops a read that has already set `loading: true`. When the drop came from a
**deselect** (a null node, session or peer) rather than from a newer read, nothing set
loading back to false. This needs no race. A workspace switch first runs the refresh effect
with the new bank and the old selection, which starts a read. Then the scope effect clears
the selection, and the null branch bumps the generation and returns.

What the user saw:

- **Knowledge.** After a workspace switch, or clicking "New" while a node was open, the
  draft pane showed NodeHead "loading…" and RevisionHistory "loading history…". Before
  the first round it showed "no accepted revision".
- **Forum and Context.** ForumView showed "Fetching messages…" permanently, and
  ContextPanel's Refresh button stayed disabled.

`useEvidenceReview` already had generation guards before this slice, and it had the same
shape of latch, which only a race could reach.

| Hook | Fix |
|---|---|
| `useKnowledge.refresh` | The null branch calls `setLoading(false)`. |
| `useMemory.refreshMessages` / `refreshContext` | The null branches call `setLoadingMessages(false)` / `setLoadingContext(false)`. |
| `useEvidenceReview` lifecycle, association, session links | The null branches clear their own loading flag. |
| `useEvidenceReview` dependents | `setDependentsLoading(false)` runs at the association bump itself. A failed or empty association on the next node never issues the reverse read that would clear the previous node's flag. |
| `useEvidenceReview` trace | The scope reset that bumps `traceGen` also clears `traceLoading`. |
| `useListing`, `useNodeLifecycle`, `useKnowledgeSearch`, `useOverview` | Checked. Every bump is followed by a read that clears the flag, or the early return already clears it. No change. |

### `src/state/loadingLatch.test.tsx`, through the real hooks

- **On the previous HEAD (fba1abd): 0 pass / 6 fail.** Every failure was
  `Expected: false / Received: true`. They cover the verifier's four probes (Knowledge
  workspace switch, Knowledge "New" mid-read, Memory workspace switch after settle, and
  Memory context mid-read with App's `[peer, session]` effect mirrored in the harness),
  plus two useEvidenceReview cases: deselect mid-read, and a scope switch mid-trace.
- **Added after the fix, each red before its own fix:** a case where B's dependents read
  is in flight and the next node's association answers `null` (1 fail before the bump-site
  clear), and a deselect with the association read itself in flight (added because
  mutant M5 survived without it).
- **After the fix:** 8 pass / 0 fail.

Mutants, one line removed at a time from the fixed code. Every mutant fails its matching
test:

| Mutant | Result |
|---|---|
| M1 `useKnowledge` null branch `setLoading(false)` | both Knowledge tests fail (6/2) |
| M2 `useMemory` `setLoadingMessages(false)` | both Memory tests fail (6/2) |
| M3 `useMemory` `setLoadingContext(false)` | the context test fails (7/1) |
| M4 `useEvidenceReview` `setLifecycleLoading(false)` | the deselect test fails (7/1) |
| M5 `useEvidenceReview` `setAssociationLoading(false)` | the association in-flight test fails (7/1) |
| M6 `useEvidenceReview` bump-site `setDependentsLoading(false)` | the deselect and "no evidence" tests fail (6/2) |
| M7 `useEvidenceReview` `setSessionLinksLoading(false)` | the deselect test fails (7/1) |
| M8 `useEvidenceReview` scope reset `setTraceLoading(false)` | the trace test fails (7/1) |

Other checks in this round:

- `bun test src` (app/ui/v2): 214 pass, 0 fail.
- UI `tsc -p tsconfig.json`: exit 0.
- `bun run typecheck` (app/server): exit 0.
- Python guard: 269 tests, `OK (skipped=1)`.
- Bundle rebuilt as `index-BEtvicZa.js`.
- Acceptor live probe, re-run on this tree: 57 methods on HTTP, MCP and CLI; isolation
  191 pass / 0 fail; 26 payload gaps; 0 seed errors; fatal none; rc 2. That is the same
  result as the first round (gaps give rc 2), and this slice changes nothing on the server.

### Live, on this round's bundle (fresh gated stack, ego-browser space 260)

The same `ui-stale-stack.sh` built a fresh mktemp stack: B and S2 were published and
`supersedeNode(B → S2)` was run through the CLI. The server served `index-BEtvicZa.js`.
CDP latency was 150 ms.

**The latch, 5 attempts per scenario.** Scenarios:

- **K1:** open B, let it settle, type `ws2` into the WorkspaceBar, click New.
- **K2:** B's reads are held for 1.5 s in-page, and New is clicked while 2 of them are in
  flight.
- **F:** forum and messages views on `alice`/`s1`, then switch the workspace.

| Bundle | K1: draft pane | K2: draft pane | F forum | F messages (ContextPanel button) |
|---|---|---|---|---|
| fixed (`index-BEtvicZa.js`) | 5/5 "no accepted revision" | 5/5 "no accepted revision" | 5/5 no "Fetching messages…" | 5/5 "Refresh" |
| first round (`index-9YwOro3f.js`, control) | 5/5 **"loading…" + "loading history…"** | 5/5 **"loading…" + "loading history…"** | 5/5 **"Fetching messages for this session…"** | 5/5 "Refresh" |

The messages control did not latch because this script switches the workspace only after
getContext has answered. The verifier's context latch needs the switch to land while
getContext is in flight, and the unit test covers that case. For the control, the
first-round files were written into `app/server/public/v2` temporarily and restored with
`git checkout` afterwards. The worktree was clean afterwards.

**Successor link, re-run on this bundle** (the first round's `ui-stale-proof.mjs`):

- **settle: 10/10** show S2's id, title and body, with 0 B head/history requests after
  the click.
- **hold: 10/10**, with B's read held in flight at the click on attempts 2–10 and dropped.

**Screenshot.** `Page.captureScreenshot` timed out again, so there is still no image.

**Teardown.**

- The origin's localStorage went from 5 keys to 0, and sessionStorage was already 0.
- The space was finished with `keep: []`.
- `ui-stale-stack.sh down` ran. `kill -0` on the server pid then gave "no such process",
  and `ls` on the mktemp root gave "No such file or directory".
- Raw results are in `.tmp/ui-stale-fix/` (git-ignored).

### Still open, not fixed in this round

- **App-level `useStableBank` has no unit test.** `useKnowledge` stabilises the bank
  itself, which hides a revert of App.tsx alone. The claimed drop in Evidence and Overview
  refetches rests only on the live settle run.
- **Transient badges while S2 loads.** KnowledgeView derives the TypeBadge and
  HorizonBadge from B's head beside S2's id, and `useNodeLifecycle` receives B's head
  revision id as `refreshKey`, which costs one extra lifecycle read. NodeHead is masked by
  `loading`, and the state is correct once it settles. This predates the slice.
- **User-triggered actions have no scope guard:** `useMemory.ask` / `verify` /
  `verifyAll` and `useKnowledge.actions.seed` / `publish`.
- **No screenshot for this slice.** `Page.captureScreenshot` times out in this ego-browser
  session. The browser evidence is DOM reads only.

## Round 3 (2026-09-27): a keyed guard, because the counter lost to stale closures

**The finding.** Round 2's guard was "the latest call wins". `useMemory.send` and `join`
called the `refreshMessages` / `refreshContext` bound at click time, which carried the
session of that render. Send in sA, switch to sB mid-append: B's read goes out, then the
post-send read for sA bumps the counter and wins. `useEvidenceReview.applyLifecycleWrite`
had the same shape for the node, and `useListing.refreshAll` (`[]` deps) re-read the first
render's workspace on every switch.

**The fix.** `src/state/useKeyedRead.ts` replaces the counters in `useMemory`,
`useKnowledge`, `useListing` and `useEvidenceReview`:

- a ref rewritten on every render holds the current key (node, session or scope tuple)
  and the values it came from. `begin()` reads the selection from it, never from the
  caller's closure, so every post-write refresh reads what is on screen.
- a result lands only while its key is still current (`live`). Reads for the same key are
  ordered too: the newest wins, so a select-time read cannot erase a post-send one, and a
  fast next/prev keeps its order. Since `begin()` only issues for the current key, the
  newest read can no longer be for a place already left.
- `loading` is derived: true only while the current key has a read pending. The round-1
  `setLoading(false)` lines in the null branches are gone; a deselect or scope switch
  changes the key, so the flag cannot latch.

`useLifecycleWrites.ts` holds retire and supersede (split out to keep
`useEvidenceReview.ts` at 424 lines). A write that lands after the node changed refreshes
the node on screen and does not set node A's outcome under node B.

### `src/state/staleClosure.test.tsx`, failing-first through the real hooks

On HEAD 3cd456c (`.tmp/ui-stale-r3/red-head.txt`): **1 pass / 6 fail**.

| Test | On HEAD | Fixed |
|---|---|---|
| send in sA, switch to sB mid-append: ends on sB's transcript | fail (`["mA1"]` under sB) | pass |
| join in sA, switch to sB mid-join (App's context effect mirrored) | fail (`cA1` under sB) | pass |
| send in sA, deselect mid-append: no transcript, no latched loading | fail (sA's rows under no session) | pass |
| retire A, switch to B mid-write: B's lifecycle rows, no A outcome | fail (A's rows under B) | pass |
| workspace switch after the first render reads wsTWO | fail (no wsTWO request at all) | pass |
| refresh-all after a switch reads the current workspace | fail (three wsONE requests) | pass |
| publish S2 from B, B's read answering last: S2 on screen | pass (keep-green guard) | pass |
| trace looked up in w1, answering after a switch to w2, does not land | added after the mutant run below (not failing-first) | pass |

Whole UI suite after the fix: **299 pass / 0 fail**.

### Mutants (`.tmp/ui-stale-r3/mutants.txt`, run against the four stale-read test files)

| Mutant | Killed by |
|---|---|
| `live()` ignores the key (the round-2 counter) | the trace test. It **survived** the first run, which is why that test exists: a scope switch starts no new lookup, so only the key can drop the old one |
| `live()` ignores the sequence (key only) | the audit "show history" toggle test (same key, two loads) |
| the ref frozen at mount (a stale closure) | 17 tests |
| `loading` not tied to the current key | loadingLatch "scope switch mid-trace-lookup" |
| lifecycle write outcome applied whatever node is on screen | the retire-A-switch-to-B test |
| `useListing.load` uses the render-bound `fetchPage` | both workspace-switch tests and the toggle test |
| `useMemory.refreshMessages` uses its closure's session | send-switch and send-deselect |

### Live, fresh gated stack, ego-browser (space 269), bundle `index-C7qWYZZr.js`

The stack is `.tmp/ui-stale-r3/stack.sh`, which is `.tmp/ui-stale-stack.sh` plus a second
session `s2` that alice joins.

| Run | Result |
|---|---|
| successor B → S2, settle, 10× | **10 / 10** show S2's id, title and body |
| successor B → S2, hold, 10× | **10 / 10** |
| Messages: send in s1, `appendMessages` held 0.8–1.2 s, switch to s2 mid-append, any s1 `listMessages` delayed 0.4–0.9 s, 6× | **6 / 6** end on s2 showing "No messages yet" and no s1 message. The post-send read goes to s2 (`appendMessages(s1)`, `listMessages(s2)`, `getContext(s2)`, `listMessages(s2)`), and all six sends were written to s1 |
| same send-switch run on the round-2 bundle (`index-DGxyeGVx.js`, 3cd456c), 6× | **0 / 6**. s2 is selected, yet s1's 7+ messages are shown, and a `listMessages(s1)` fires after the append |

There is no screenshot: `Page.captureScreenshot` timed out, so the evidence is DOM reads
(`.tmp/ui-stale-r3/successor-*.json`, `send-switch-fixed.json`,
`send-switch-round2-bundle.json`). Afterwards the server and its mktemp root were removed,
the origin's localStorage was cleared (3 keys → 0), and the space was finished.

### The App-level `useStableBank` is still not pinned

Reverting App.tsx alone would not turn any test red. A DOM is not the obstacle:
`src/testing/installFakeDom.ts` can mount the real `App`. The pin was not written inside
this round's time box. The one consumer it still protects is `useEvidenceReview`, whose
refresh callbacks depend on `b` identity. There, an unstable bank means re-requests on
every App render (wasted work), and no longer wrong data, because the keyed guard compares
strings. Still open.

## Actions (2026-09-27, slice `ui-actions`, branch `v4/on-ui-actions`)

Closes the two items round 3 left open ("User-triggered actions have no scope guard" and
"App-level `useStableBank` has no unit test"). UI only: nothing under `app/server/src`
changed, and no contract under `app/docs/contracts/` changed, so no contract amendment
was needed. `git diff --stat` against `d949290` touches only `app/ui/v2/src/**` and the
rebuilt `app/server/public/v2` bundle.

### The bug

Round 3's `useKeyedRead` guards every READ (`refreshMessages`, `refreshContext`, the
knowledge/evidence lanes). It never reached the ACTIONS layered on top: `useMemory.ask`
set `answer`/`askError` from whatever `answerChat` call happened to resolve, with no check
that the peer/session it was asked for was still selected. `send`/`join` set
`messageError` the same way. `useMemory.verify` (the roster peer/session check behind
`addPeer`/`addSession`) applied its verdict to whatever workspace's roster was in React
state when it resolved, not the one it was issued for. `useKnowledge.seed` pinned a
taxonomy id set under whatever scope was current at LAND time, and `publish` forced
`setSelected`/bookmarked a node under a scope it may have already left.

### The fix

| File | Change |
|---|---|
| `app/ui/v2/src/state/useMemory.ts` | `ask` gets its own `useKeyedRead` ticket (`askRead`, same `contextKey` shape as `contextRead`): the answer/error land only while `askRead.land(t)` says the peer+session are still current. `send`/`join` capture `messagesKey({b, session})` at issue time and compare it against `messagesRead.now.current.key` (updated every render) before writing `messageError`. `verify` captures `workspace` at issue time and compares against a `workspaceRef` before writing a roster verdict. |
| `app/ui/v2/src/state/useKnowledge.ts` | `seed` captures `scope` at issue time in a `scopeRef` and drops the taxonomy pin if the scope moved on. `publish` keeps the write (it happened) but drops the forced `setSelected`/bookmark if the scope moved on -- a node switch within the SAME scope still navigates, since "go look at what you just published" is the point. |
| `app/ui/v2/src/App.stableBank.test.tsx` (new) | Mounts the real `App` (via `installFakeDom`) on the Explore view with a node selected, forces a second top-level render with no selection change, and asserts no new `listLifecycleHistory`/`getRecallEligibility`/`getRevisionAssociations` request went out. `useKnowledge` already stabilises its own `bank` argument, so this had to go through a consumer with none: `useEvidenceReview`, wired in via Explore. |
| `app/ui/v2/src/state/actionStale.test.tsx` (new) | Failing-first, through the real `useMemory`/`useKnowledge` hooks, one test per action: `ask`, `send`'s error, `seed`, `verify`. |

**Policy, stated once because the reasoning repeats:** every one of these is DROP. None of
`ask`'s answer slot, `send`/`join`'s single error line, `seed`'s taxonomy pin, or `verify`'s
roster verdict has a place to attribute a stale result TO -- each is "what's true for the
selection on screen now", not a per-session/per-workspace log. A result for a selection
already left is discarded, exactly like `useKeyedRead`'s read guard drops a stale read.
`publish` is the one exception with nuance: the WRITE stays (it is real, wherever it
targeted), only the forced navigation/bookmark is dropped on a scope change, because
undoing a write that already happened would be its own lie.

### Failing-first, through the real hooks

`src/state/actionStale.test.tsx`, on the unfixed hooks (HEAD `d949290`): **0 pass / 4 fail**.

```
(fail) useMemory.ask ... ask in sA, switch to sB mid-ask: no sA answer under sB
    expect(m.get().answer).toBe(null);
    Received: { answer: "sA's answer", items_used: [] }
(fail) useMemory.send ... send fails in sA after switching to sB: messageError stays clear
    expect(m.get().messageError).toBe(null);
    Received: "conflict"
(fail) useKnowledge.seed ... seed resolves in w1 after switching to w2: w2's taxonomy stays unset
    expect(k.get().taxonomy).toBe(null);
    Received: { type: {...}, memory_horizon: {...} }   -- w1's minted ids, under w2
(fail) useMemory.verify ... alice verified live in w2 stays live after w1's stale 'missing' answer lands
    expect(alice?.state).toBe("live");
    Received: "missing"
```

With the fix: **4 pass, 0 fail**.

`App.stableBank.test.tsx`, with App.tsx's `useStableBank` line reverted to the inline
literal `{ bank: m.bank, token: m.token, workspace: m.workspace }` (the round-3 gap):
**0 pass / 1 fail** --

```
expect(after[method] ?? 0).toBe(before[method] ?? 0);
Expected: 3
Received: 4   -- one extra listLifecycleHistory fired by the unrelated re-render
```

With `useStableBank` restored: **1 pass, 0 fail**.

### Mutants: one line removed at a time from the fixed code, restored after each

| Mutant | Result |
|---|---|
| `ask`: drop `if (!stillCurrent) return;` | the ask test fails (3 pass / 1 fail) |
| `send`: drop the `messagesRead.now.current.key === issuedKey` check | the send test fails (3 pass / 1 fail) |
| `verify`: drop the `workspaceRef.current !== issuedInWorkspace` check | the verify test fails (3 pass / 1 fail) |
| `useKnowledge.seed`: drop the `scopeRef.current !== issuedInScope` check | the seed test fails (3 pass / 1 fail) |
| `App.tsx`: `useStableBank` call reverted to the inline literal | `App.stableBank.test.tsx` fails (0 pass / 1 fail) |

After each mutant the file was restored, and `diff` against the pre-mutant copy confirmed
it matched the fix exactly.

### Other checks

- Targeted suites (16 files covering every hook/component that imports `useMemory`,
  `useKnowledge`, `useEvidenceReview`, `useLifecycleWrites` or `useStableBank`, found with
  `rg`): **70 pass, 0 fail**.
- `npx tsc --noEmit -p app/ui/v2/tsconfig.json`: exit 0.
- Python architecture guard (`app/migrate-py`, `unittest discover -s tests`): 269 tests,
  `OK (skipped=1)`. No TS file imports the publication kernel; nothing under
  `app/server/src` changed.
- Every touched/added file stays well under 500 lines (`useMemory.ts` 282,
  `useKnowledge.ts` 286, `actionStale.test.tsx` 180, `App.stableBank.test.tsx` 107).
- Bundle rebuilt: `bun run build` (app/ui/v2) into `app/server/public/v2`,
  `index-Cz5DXbTB.js`. Verified byte-identical hash before and after the control-mutant
  detour (built once clean, once with the `ask` mutant for the live control run below,
  once more restored -- the final rebuild reproduced the same `index-Cz5DXbTB.js`).
- Acceptor live probe (`run.sh … ui-actions`), fresh mktemp run: 57 methods, each exposed
  over HTTP, MCP and CLI; isolation **191 pass / 0 fail**; 26 payload gaps; 0 seed errors;
  fatal none. Start HEAD and end HEAD both `d949290` -- this slice changed nothing on the
  server. Same gap count as the prior two rounds (missing fixtures in the probe itself, not
  a regression here).

### Live proof (fresh gated stack, ego-browser)

**Stack.** `.tmp/ui-actions-stack.sh` (git-ignored, built from `app/just/demo/{lib,stack}.sh`,
the same building blocks `demo.sh`/`ui-stale-stack.sh` use): a fresh `mktemp -d` target19 +
legacy15 dataset, a dev policy/token, and a writer-gated server on a free port. Peer `alice`
registered, sessions `s1`/`s2` both created and joined by `alice`, one seed message in each
(`s1`: migration/disk-snapshot note; `s2`: an unrelated espresso-machine note). Real local
Ollama `gemma3:4b` answered every `answerChat` call for real (measured round trip ~0.35s
via a direct `curl`) -- the race was built with an **in-page `fetch` wrapper** (the brief's
documented alternative to depending on model latency) that let the real request complete,
then held the resolved response an extra 1200ms before returning it to the app, and
prefixed the answer text with `ANSWER-FOR-<session_name>` so the check is exact-string,
not a judgment call about model phrasing.

**Browser.** ego-browser, space 280, one page, served from `http://127.0.0.1:<port>/v2/`
(same-origin, `?token=` unlock).

**Procedure, 5 attempts.** Each attempt: select session `s1` (peer `alice` already
selected), type a fresh question, click Ask, wait 200ms (long enough for the request to
leave), switch to session `s2`, wait 3000ms (comfortably past the measured ~0.35s real
round trip plus the 1200ms artificial hold), then check the page text for
`ANSWER-FOR-s1`.

| Bundle | Attempts showing no `s1` answer under `s2` |
|---|---|
| fixed (`index-Cz5DXbTB.js`) | **5 / 5** |
| control: `ask`'s stale-check line removed, same bundle build, same wait | **0 / 3** (leaked every time) |

Restoring the source and rebuilding reproduced the exact same fixed bundle hash
(`index-Cz5DXbTB.js`), confirming the control detour left no drift.

**Sanity.** With no switch at all, asking in `s1` and waiting still shows
`ANSWER-FOR-s1: <real gemma3:4b answer, citing the s1 message's own public_id>` -- the
drop is selection-scoped, not "ask no longer works".

**Teardown.**

- ego-browser space 280 finished with `keep: []`.
- The origin's localStorage went from 2 keys (`arra-ui-v2-token`,
  `arra-ui-v2-roster:default`) to 0; sessionStorage was already 0.
- `.tmp/ui-actions-stack.sh down`: `kill -TERM` on the server pid, then `kill -0` gave "no
  such process"; `rm -rf` on the mktemp root, then `ls` gave "No such file or directory".

### Still open

- `verifyAll`/`registerPeer`/`registerSession` share `verify`'s new guard (they call it),
  so they inherit the fix; no separate test was added for `registerPeer`/`registerSession`
  themselves beyond the shared `verify` coverage.
- `useKnowledge.publish`'s dropped-navigation branch (scope changed mid-publish) has no
  dedicated failing-first test in this round -- it was added for completeness alongside
  `seed` (same `scopeRef`), reasoned through, and covered indirectly by the existing
  `staleClosure.test.tsx` "B-after-S2" test staying green, but that test never moves
  `scope` mid-publish. Flagged for the next pass rather than papered over.

## Fix round 2 (2026-09-27): four blocking findings from an independent Opus verifier

Round 1 above claimed the answer/verify/publish guards were closed. An independent
verifier refuted that with scratch tests against slice HEAD `7d572ca`; see
`docs/overnight/DECISIONS.md`'s R12 ("Model split tonight") for why #33 AC1 (peer-context
chat) is the ruling this slice implements, and the acceptor verdict this round answers.
Correcting two inaccuracies in round 1's own text while here: "Start HEAD and end HEAD
both `d949290`" only shows the probe ran before this round's commits, not that nothing
changed (true separately, by `git diff --stat` against `d949290` touching no
`app/server/src` file) -- and round 1's claim to have appended a section "citing
`docs/overnight/DECISIONS.md`" was not actually true (no reference existed); this
paragraph is that reference.

### What was actually still broken

1. **`useMemory`'s ask answer/error were guarded only at LAND time, never cleared
   afterward.** `askRead.land(t)` correctly drops a response still in flight when the
   selection moves on -- but if the answer already SETTLED while sA was still on screen,
   nothing cleared `answer`/`askError` on the later switch to sB. Round 1's own
   `actionStale.test.tsx` test only moved the switch BEFORE the response arrived, so it
   never exercised this. Verifier's scratch repro: ask in sA, let it settle, switch to sB
   -- `answer` stayed `{"answer":"sA's answer",...}` under sB.
2. **`useKnowledge.publish` resolved `true` after a scope switch even when it had already
   decided to drop the navigation.** Both `KnowledgeView` callers do
   `.then(ok => { if (!ok) return; ...onSelectNode(target) })`; a `true` made them navigate
   onto the old scope's node id inside the new scope regardless of the hook's own
   `stillInScope` check.
3. **`useMemory.verify`'s freshness guard compared only `workspace`**, unlike every other
   key in the hook (`[bank, workspace, token]`). A verify issued under a token since
   replaced could still overwrite a same-workspace verdict fetched under the current
   token.
4. **(nonblocking, fixed anyway) `asking` was a single unkeyed flag.** Asking in sA and
   switching to sB showed "Asking..." (and a disabled Ask button) under sB until sA's
   model call returned. Fixed by exposing `askRead.loading` (already keyed on
   peer+session) as `asking`, instead of a separate unkeyed `useState`.

### Fix

| File | Change |
|---|---|
| `app/ui/v2/src/state/useMemory.ts` | New `useEffect` keyed on `[b.bank, b.workspace, b.token, peer, session]` clears `answer`/`askError` the instant the selection moves on -- independent of whether a request is in flight. `verify`'s freshness ref is now `` `${bank}:${workspace}:${token}` `` (`bKeyRef`), not `workspace` alone. `asking` is now `askRead.loading` (the manual `useState` was removed). |
| `app/ui/v2/src/state/useKnowledge.ts` | `publish` now returns `stillInScope` instead of an unconditional `true` at the end. |
| `app/ui/v2/src/state/actionStale.test.tsx` | 5 new tests: settled-answer-then-switch, settled-askError-then-switch, `asking` cleared on switch while in flight, publish resolving `false` after a scope switch, and a stale-TOKEN verify (same workspace) not overwriting the current verdict. |

### Failing-first, through the real hooks

`src/state/actionStale.test.tsx`, the 5 new tests against slice HEAD `7d572ca`
(unfixed): **0 pass / 5 fail**.

```
(fail) ask settles in sA, then switch to sB: sA's answer is cleared, not shown under sB
    expect(m.get().answer).toBe(null);
    Received: { answer: "sA's answer", items_used: ["mA1"] }
(fail) askError settles in sA, then switch to sB: askError is cleared
    expect(m.get().askError).toBe(null);
    Received: "model_unavailable"
(fail) switching to sB while sA's ask is in flight clears `asking` immediately
    expect(m.get().asking).toBe(false);
    Received: true
(fail) publish resolves false (not true) after a scope switch
    expect(resolved).toBe(false);
    Received: true
(fail) bad-token verify landing after good-token verify leaves alice live
    expect(alice?.state).toBe("live");
    Received: "unknown"
```

With the fix: **9 pass, 0 fail** (4 round-1 tests + 5 new).

### Mutants

| Mutant | Result |
|---|---|
| Remove the new `useEffect` clearing `answer`/`askError` | the settled-then-switch tests fail (7 pass / 2 fail) |
| `useKnowledge.publish`: `return stillInScope;` -> `return true;` | the publish-scope test fails (8 pass / 1 fail) |
| `verify`: `bKeyRef.current !== issuedKey` -> compare `workspace` only (round-1 shape) | the stale-token verify test fails (8 pass / 1 fail) |

### Other checks (this round)

- Targeted suites: `actionStale.test.tsx` (9 pass), `useKnowledge.publish.test.tsx`,
  `staleReads.audit.test.tsx`, `staleClosure.test.tsx`, `useKnowledge.stale.test.tsx`,
  `loadingLatch.test.tsx`, `App.stableBank.test.tsx` (26 pass combined), plus the two
  files referencing `DialecticPanel` (`reflowText.test.ts`, `a11yNames.test.ts`, 13 pass)
  -- **48 pass, 0 fail** total.
- `tsc --noEmit -p app/ui/v2/tsconfig.json`: exit 0. `bun run typecheck` in `app/server`:
  exit 0 (unaffected; no `app/server/src` change).
- Python architecture guard (`app/migrate-py`, `unittest discover -s tests`): 269 tests,
  `OK (skipped=1)`.
- Every touched file stays well under 500 lines (`useMemory.ts` ~300,
  `useKnowledge.ts` ~294, `actionStale.test.tsx` ~325).
- Bundle rebuilt: `bun run build` (`app/ui/v2`) into `app/server/public/v2`.

### Explicitly NOT done this round (deviations, not papered over)

The brief's hard time box (40 minutes) did not leave room for every nonblocking item the
verifier listed. Left as-is, stated here rather than silently dropped:

- **`join` guard has no dedicated test.** The mutant the verifier described (`if
  (!result.ok) setMessageError(...)` unconditionally) is real and still uncaught by the
  targeted suites run this round.
- **`WorkspaceBar.tsx`'s `ping`** (`health(bank).then(onHealth)`) is still unguarded.
  Low impact (`/health` is public, per the verifier's own note); not touched.
- **`useKnowledge.seed`'s freshness key is still `` `${bank}:${workspace}` `` (no
  token).** A stale error from an old token can still set `error` in the same scope.
  The verifier called this "Minor"; left alone to stay inside the time box.
- **`App.stableBank.test.tsx` still does not restore `globalThis.localStorage`** in an
  `afterEach`. No observed cross-file effect (full targeted run above is clean), but the
  hygiene gap itself is unfixed.
- **Live ego-browser re-run was not performed this round.** The brief's "LIVE with
  ego-browser on a fresh gated stack ... at least 5 attempts" step (see round 1's own
  "Live proof" section above, 5/5 with the round-1 bundle) was not repeated against this
  round's rebuilt bundle inside the time box; the fixes are proven only at the hook level
  (failing-first + mutants) and by the acceptor's live probe (`run.sh`, HTTP/MCP/CLI
  surface + isolation), not by a fresh browser session. Flagged rather than claimed.

## Reads, round 2 (ui-reads2, 2026-09-27)

Fixes the non-blocking r3 findings (`.tmp/ui-actions-r3-findings.txt`) on the
ui-actions base (61ab682). UI only; `app/server/src` untouched. Base 310 UI tests,
now 401/401 across 65 files (`bun test ./src` in `app/ui/v2`).

| # | Finding | Red before the fix (decisive line) | Fix |
|---|---|---|---|
| 1 | trace lookup dropped via `live()` skipped `land()` | `loadingLatch` "w1 lookup answering while on w2": `Expected: false, Received: true` | every `begin()` (9 sites) lands on every path, in a `finally` where a throw was possible; `useKnowledge:129` was the same shape (not latchable there, fixed anyway) |
| 2 | seq matching unpinned | new `keyedReadSeq.test.tsx` green on base; M1 0/3 pass, M3 1/3, M4 0/3 (`Expected: true, Received: false` at the "loading stays on" line) | tests only; same counts re-run on the fixed code |
| 3 | `peek()` aliasing | hits: `+ "t1-p2"` after `"t2-p1"`; links: `Expected to not contain: "sB\|cA"`, `Received: ["sB\|", "sB\|cA"]` | `useMorePages`: a load-more carries the result's key, values, cursor and generation; issues only while that key is on screen, lands only while that generation is. `peek()` removed. Hits, session links, dependents |
| 4 | 200 + null body latched listing | `TypeError: null is not an object (evaluating 'body.rows')`, loading `Received: true` | `toPage` returns "malformed listing response (no body)"; `useListing.load` also catches, lands in `finally`, shows the failure |
| 5 | carried over | ask: `Expected ["sB"], Received ["sA"]`; join guard had no test (removing the guard now reads `Received: "invalid_reference"`) | **ask sends with its ticket's values** (the selection on screen), the same values it is keyed on, as `refreshContext` does. `App.stableBank.test.tsx` restores `fetch` and `localStorage` |

Not proven red: the `App.stableBank` restore (hygiene; no cross-file failure observed)
and the dependents load-more (same `useMorePages` path as hits/links, no own test).
Acceptor live probe (`run.sh ... ui-reads2`, HEAD 6d29166): 57 methods on HTTP/MCP/CLI,
isolation 191 pass / 0 fail, seed errors 0, fatal none; rc 2 from 26 payload gaps, the
same count as the accepted ui-actions base (`verify-ui-actions-2`). No browser re-run.
