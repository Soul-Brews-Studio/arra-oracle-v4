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
| `useKnowledge.refresh` | No guard, last response wins (**the bug**). Keyed on bank identity. | Fixed (gen + `useStableBank`) |
| `App.tsx` bank prop | New object per render, fed to Overview, Explore and Knowledge | Fixed (`useStableBank`) |
| `useMemory.refreshMessages` / `refreshContext` | No guard. A fast session switch showed A's transcript or context under B | Fixed (gen per lane) |
| `useListing` → `useCursorList.load` | No guard. Toggling "show history", a scope change, or a fast next/prev let the older page land last | Fixed (gen) |
| `useEvidenceReview` (trace, session links, lifecycle, association + dependents, every load-more) | Already has a generation counter per lane. Its `refresh*` callbacks depend on `b` identity, so before the App fix every App render refetched the Evidence panels. They showed no wrong data, only wasted requests. The fix round found the loading latch below in four of its lanes | Covered by the App fix. Loading latch fixed in the fix round |
| `useNodeLifecycle` (LifecycleBanner's source) | Already guarded (gen). Deps are on the bank's strings | No change |
| `useEvidenceStatus` | Already guarded (gen per lane). Deps are on the bank's strings | No change |
| `useKnowledgeSearch` | Already guarded (request id + debounce). Deps are on the bank's strings | No change |
| `useOverview` | Already guarded (volley id). `OverviewView` memoises the bank itself | No change |
| `useCiteTargets`, `useRoute`, `useToken` | No fetch | No change |
| `KnowledgeView` / `ExploreView` effects | Route → hook-state sync only, no fetch | No change |
| `useMemory.ask`, `verify`/`verifyAll`, `useKnowledge.actions.seed`/`publish`, `WorkspaceBar.ping` | User-triggered actions, not effect reads. A switch while one is in flight can still land its result in the new selection or scope. Examples: `seed`'s taxonomy ids saved under a newly chosen bank, or a chat answer shown beside a different session | **Not fixed.** Listed as an open risk |

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
