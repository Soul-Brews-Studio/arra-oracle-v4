# UI proof: slice `ui-a11y` (#33 AC2 + R12 + Nat UI style) — FIX ROUND

**Branch**: `v4/on-ui-a11y`, worktree `wt/arra-oracle-v4-ui-a11y-27sep-sun2026`. Scope: `app/ui/v2`
only, plus this doc. `app/server/src` was not touched. **Base correction** (nonblocking finding
from the previous round): the real base is `origin/main` `01ba604` (`git merge-base HEAD
origin/main`), not `b3fa70d` — `01ba604` was already `v4/on-ci-dedupe` merged. `git diff
01ba604..HEAD` touches only `app/ui/v2/src` and `docs/overnight`.

An independent Opus verifier REFUTED the first round on three blocking points. This is the fix
round: each is addressed below with a failing-first test, the fix, and a live re-measurement.

## Blocking finding 1 — the 830px defect was NOT fixed

**Root cause the verifier found**: the only breakpoint in the compiled CSS was `@media
(min-width:768px)` (Tailwind's `md:`), so every width ≥ 768px — including 830 — still got the
desktop layout: fixed `w-64`/`w-96` asides eating 640px of an 830px viewport, leaving ~190px for
content. The first round's own screenshots were taken at 553/960 CSS px (a CDP scaling artifact,
documented below), never at a true 830/1440, which is how the defect went unnoticed.

**Fix**: every `md:` breakpoint controlling this row/aside layout is now `lg:` (1024px), in
`KnowledgeView.tsx` (:82,83,216), `App.tsx` (:169,225 — the "messages" tab's `SidebarShell` +
`DialecticPanel`/`ContextPanel` aside), `explore/ExploreView.tsx` (:114,115), and
`components/SidebarShell.tsx` (:48). Below 1024px the row container stays `flex-col` (stacked,
full-width panels); at/above 1024px it becomes `flex-row` with the original fixed aside widths.
`rg -n 'md:' app/ui/v2/src` now returns zero hits.

**Failing-first test**: `components/SidebarShell.test.ts` (new) asserts the rail's classes are
`lg:`-scoped and contain no `md:` at all — written against the OLD `md:w-60` source, confirmed
red, then green after the fix. (The full render-in-browser measurement below is the primary
proof for this finding; render tests can lock the Tailwind class strings but cannot themselves
measure a compiled cascade.)

**Live re-measurement** (the mistake to avoid this round: measuring the wrong CSS-px width).
This sandbox's ego-browser reports `window.innerWidth` at **1.5× the CDP-requested width**
(confirmed by probing: requesting CDP width 830 measured `innerWidth=553`, i.e. `830/1.5`).
Every width below is the CDP override **already multiplied by 1.5** and then *verified* by
reading `window.innerWidth` back — not assumed:

| requested CSS px | `innerWidth` read back | `scrollWidth` | overflow? |
|---|---|---|---|
| 375 | 375 | 375 | no |
| 830 | 830 | 830 | no |
| 1440 | 1440 | 1440 | no |

Checked across **all 6 named surfaces** (Overview, Explore/nodes, Explore/evidence, Messages,
Forum, Knowledge) at all three widths — 18/18 `scrollWidth === innerWidth`, zero overflow,
before *and* after confirming the stacking actually happened (not just "no overflow by luck"):

| view | @830 asides | @830 main | @1440 asides | @1440 main |
|---|---|---|---|---|
| Knowledge | **[830, 830]** (full width, stacked) | 830 | [256, 384] | 800 |
| Messages | **[830, 830]** (full width, stacked) | 830 | [240, 384] | 816 |

At 830 both asides now render at the full viewport width (stacked above/below the content, not
beside it) instead of the pre-fix `[256,384]`/`[240,384]` fixed pair that left 190/206px for
content. At 1440 the desktop two-column layout is unchanged (`256+384+800=1440`,
`240+384+816=1440`) — the fix only moves *where* the switch happens, not what either side of it
looks like.

**Deviation from the ruling**: `NodeHead.tsx`'s `min-w-0 break-words` title fix and the
`flex-wrap` tab bars were already in place from the first round (verified by reading the
current source, not re-added) and are unchanged this round. Screenshot capture at the CDP
device-metrics override consistently timed out in this sandbox this session
(`CdpRequestTimeoutError: Page.captureScreenshot`, reproduced on a fresh Page with the override
cleared and on a brand-new Page — an environment issue, not a rendering one), so the
375/830/1440 PNGs from the first round are **not replaced** and remain mislabelled (553/960 CSS
px, disclosed already). The numeric `page.evaluate` proof above — the form of evidence AC2 asks
for — was captured live against this exact branch's build; a follow-up session with working
screenshot capture should re-shoot `36-a11y-{375,830,1440}-knowledge.png` at the verified exact
widths.

## Blocking finding 2 — false-empty on a real 401/403 (Explore lists)

**Root cause**: `api/listing.ts`'s `toPage` collapsed every non-2xx response into `{rows: [],
supported: !isUnsupported(result)}`. A real 401/403 is not "unsupported" (`isUnsupported` only
matches `method_not_found`/bare 404), so `supported` came back `true` — indistinguishable from a
genuinely empty page. `useListing` then set `error: null`, and `ListPanel.tsx` rendered "no
peers / nothing on this page matches" over a server that never got to answer.

**Fix**: `Page<T>` gained an `error: string | null` field, populated in `toPage` (and
`api/audit.ts`'s parallel decoder, which shares the type) with the real governed code (or
transport message, or `HTTP ${status}`) whenever the failure is NOT "route absent" — `supported`
now means exactly one thing: "this route exists." A new pure helper,
`state/listingErrorMessage.ts`, turns `{supported, error}` into the sentence a panel shows
(`authErrorHint` for 401/403, `request failed: ${code}` otherwise, the existing unsupported
sentence when the route is genuinely absent). `ListPanel.tsx`'s empty-state now renders only
`supported && !error && …` — an honest "no rows" no longer fires when there is a real error to
show instead.

**Failing-first tests**: `api/listing.test.ts` (new, stubbed `fetch`) and
`state/listingErrorMessage.test.ts` (new, pure) and `explore/ListPanel.test.ts` (new, render) —
13 tests, all confirmed red against the pre-fix source (stashed and re-run), all green after.

**Live re-measurement**, against the real server (not stubbed) on `Explore`:

- Bad token (401): every panel now shows *"No bearer token, or the token is not valid. Check
  the token field above and try again."* — replacing the old "no peers/no sessions/no nodes".
- A second, genuinely lower-scope credential minted on the same dev policy (a
  `readonly-scope-caller` principal with `diagnostics:read` only, no `content:read` — the same
  mechanism the overnight acceptor's live-probe uses) gets a real `403 {"error":"forbidden"}`
  from the live server, and the UI shows *"This token does not hold the permission (scope) this
  request needs. Ask for a token with the right grant, or switch workspace."* on every panel.
- Both confirmed via `curl` directly against the dev-stack server first (401/403/200 with the
  three tokens) before checking the UI, so the UI text is known to correspond to the real HTTP
  status, not a client-side guess.

## Blocking finding 3 — regression: `asError` over-decoded, breaking `chatError`

**Root cause**: the first round's `asError` fix decoded *any* `{error: string}` body as a
governed code, not only the auth gate's `unauthenticated`/`forbidden`. `auth/http.ts`'s
`ERROR_BODIES` answers the same flat shape for 400 ("bad request"), 413 ("payload too large"),
415 ("unsupported media type"), 503 ("policy unavailable"), and an unregistered route's bare 404
falls back to `{"error":"error"}`. Feeding "bad request" (a spaced string) to
`chatError.ts`'s `GOVERNED` regex made it fail to match, so `reachedServer()` returned false and
a real 400 — the server answered — was reported as *"Could not reach the server… check your
connection"*, which `chatError.ts`'s own header calls "false, not just imprecise".

**Fix**: `asError` now decodes the flat-string shape **only** for `"unauthenticated"` and
`"forbidden"` — the two codes `authErrorHint` actually explains. Every other flat body falls
through to the object-shape check, finds no `.code`, returns `null`, and `describe()` reports
`HTTP 400`/`413`/`415`/`503`/`404` — a bare status string `chatError`'s `reachedServer` already
recognizes correctly. This also restores the pre-#33 `HTTP 404` behaviour for an unregistered
route's bare fallback (nonblocking finding: the interim `code: "error"` was less informative).

**Failing-first tests**: `api/asError.test.ts` gained 5 new cases (400/413/415/503/404-fallback
must stay `null`) — confirmed red against the pre-fix source, green after. The existing
`chatError.test.ts` (400/413/415/503-equivalent via `"HTTP ${status}"`) already covers the
downstream effect and stayed green throughout, since the fix routes those codes back through the
path it was already testing.

## Nonblocking findings addressed

- **`hasLabelPair` only checked the first `for=`/`id=` pair** (`a11yNames.test.ts`): rewritten
  with `matchAll` + `.every()` so a correct first pair can no longer mask a mismatched second or
  third one. Two new tests lock this in directly (a 2-of-3-correct fixture must fail; a
  3-of-3-correct fixture must pass). `WorkspaceBar`'s own three pairs were already all correct,
  so this was a test-quality gap, not a live defect — but it is exactly the kind of gap that
  would have hidden one.
- **No automated coverage of the responsive stacking**: `components/SidebarShell.test.ts` (new)
  render-asserts the `lg:`-scoped classes, described above.
- **Base commit claim was wrong**: corrected above (`01ba604`, not `b3fa70d`).
- **404 decode regression**: fixed as a side effect of the blocking-finding-3 fix (see above).

Not re-addressed this round (time box): a second live click-through re-confirming the
`ErrorNote`/`authErrorHint` fallback path inside `KnowledgeView` specifically (the unit/render
tests for it were already green and unaffected by this round's changes); keyboard
roving-focus/`aria-selected` on list panels and code-path wrapping outside `NodeHead`'s own
title (both explicitly outside this slice's brief, called out in AC2 more broadly).

## Test suite

`bun test` in `app/ui/v2`: **160 pass / 0 fail** across 22 files (was 139/0/18 before this
round; +21 new tests: 6 in `api/listing.test.ts`, 5 in `state/listingErrorMessage.test.ts`, 2 in
`explore/ListPanel.test.ts`, 1 in `components/SidebarShell.test.ts`, 5 in `api/asError.test.ts`,
2 in `components/a11yNames.test.ts`). Every new test was confirmed **red** first: the 9 modified
source files were `git stash`-ed (keeping the new/modified test files in the working tree),
`bun test src` was run against the pre-fix source (13 failures, matching exactly the new
assertions), then the stash was popped and the suite re-run green.

`bunx tsc --noEmit`: clean (one incidental fixup needed — `api/audit.ts`'s own `Page<T>`
decoder, a deliberate second copy of `listing.ts`'s logic per that file's own comment, needed the
new `error` field to keep compiling; it now reports the same way for consistency, though nothing
currently reads more than `total` off it).

Python architecture guard (`app/migrate-py`, `PYTHONPATH=src .venv/bin/python -m unittest
discover -s tests`): 268 tests, **OK (skipped=1)** — unaffected, no server-side or Python file
was touched.

## Mandatory live-probe

`bash .../live-probe/run.sh <this-checkout> ui-a11y`: `methods=57 HTTP=57 MCP=57 CLI=57
isolation_failures=0 seed_errors=0 gaps=26 fatal=None`. Isolation **191 pass / 0 fail**. Start
HEAD == end HEAD (`06e5017…`) — this slice makes no server-side change, confirmed by the probe
itself. Identical to the first round's numbers, as expected (`app/server/src` untouched).

## Live browser proof — how it was run

Real Chrome via `/ego-browser`, a fresh `mktemp -d` target19+legacy15 dataset, a real gated
server started the same way `app/just/demo/stack.sh` does it (`resolve_ollama` +
`demo_stack_up`), on a free ephemeral port. A second, genuinely lower-scope credential
(`readonly-scope-caller`, `diagnostics:read` only) was appended to the same dev-policy JSON
in-place — `admitKnowledgeAction` calls `loadPolicy` fresh per request, so this took effect
without a server restart. `bun run build` was run before the browser session; `git checkout --
app/server/public/v2 && git clean -fdq app/server/public/v2` was run after, before committing.

**Teardown**: `task.finish({ keep: [] })` (closes the ego-browser task space, clearing its
localStorage), `kill -TERM` on the server PID, `rm -rf` on the mktemp root — all confirmed
(directory listing after removal: "No such file or directory"; `ps aux` for the server port:
no output).

## Round 3 (after the wave-5 verifier refuted round 2)

**What round 2 got wrong.** It measured widths and `scrollWidth` only, never heights. Below `lg`
the Knowledge view stacked into a column and `<main>` stayed `flex-1 overflow-y-auto`. A scroll
container's automatic min-height is 0, so `<main>` took all of the negative free space: the node
view was 6px tall at 375x812 and the NodeHead body 32px at 830x859. Explore's detail pane
(`DetailTabs`, `flex-1 min-h-0`) measured 38px at 830 and 0px at 375.

**Layout now (below `lg`).** Each view's root is the one scroll container, so the page scrolls.
- Knowledge: the bookmark rail is capped at `max-h-[40vh]` and scrolls on its own. `<main>` is
  `flex-none` and not a scroll container, so it is as tall as the node it shows.
- NodeHead is `flex-none` and has no scroller of its own. Its nested `flex-1 overflow-y-auto`
  also collapsed on desktop: after the stacked fix, it measured 32px at 1440x900.
- Explore: the lists are capped at `max-h-[45vh]`. `DetailTabs` is a named region
  (`<section aria-label="Explore detail">`) that is `shrink-0 h-[80vh] min-h-[24rem]`. Its tab
  bodies, including the transcript, scroll inside it.
- From `lg`, the three-column desktop layout is back: `lg:flex-1 lg:min-h-0`, and `<main>` is
  `lg:overflow-y-auto`.

**Measured live.** Real Chrome via `/ego-browser` `page.evaluate`. A real gated server was
started with `app/just/demo/stack.sh`'s `demo_stack_up` on a fresh `mktemp -d` target19+legacy15
dataset, with a free port and the model URL pointed at a dead port, so no model was used. The
bundle came from this branch's `bun run build` (`index-vopEcGuI.js`, confirmed from
`document.scripts`). Seed, through the real CLI:
- 12 peers and 12 sessions.
- 15 Thai/English messages in `session-01`.
- One published node: a Thai/English title about 110 characters long and a 40-line Thai/English
  body.

Widths are the CDP override × 1.5, because this sandbox renders at DPR 1.5. `innerWidth` was
read back each time.

| CSS px (`innerWidth` read back) | 375x812 | 830x859 | 1440x900 |
|---|---|---|---|
| `scrollWidth` (all 3 views) | 375 | 830 | 1440 |
| Knowledge: page scroller client/scroll | 627 / 2977 | 779 / 2119 | 819 / 819 |
| Knowledge: `<main>` height (scroll) | 2507 (2507) | 1745 (1745) | 819 (1679, its own scroller) |
| Knowledge: NodeHead height / content | **1503 / 1503** | **823 / 823** | **823 / 823** |
| Knowledge: title wraps inside its box | yes (80px, 4 lines) | yes (40px) | yes (40px) |
| Explore: lists height / content | 365 / 656 | 387 / 656 | 735 / 735 |
| Explore: DetailTabs height | **650** | **687** | 735 |
| Explore > Messages: transcript viewport / content | **414 / 1894** | **480 / 1294** | 528 / 994 |
| Messages view: transcript viewport / content | 1894 / 1894 (page scrolls) | 1294 / 1294 (page scrolls) | 649 / 1294 |

Round 2, as the verifier measured it, for comparison: Knowledge `<main>` was 6px at 375 and 147px
at 830; the NodeHead body was 32px at both. DetailTabs was 0px at 375 and 38px at 830, and the
transcript viewport was 24px at both. The messages view was not flagged and was not changed. In
stacked mode its transcript is full height, and the page scrolls to the composer.

**Screenshots** are named by their real CSS width. The PNG pixel size is 1.5× that width because
this sandbox renders at DPR 1.5:
- `ui/37-a11y-r3-375-knowledge.png` and `ui/37-a11y-r3-375-explore-messages.png` are 563x1218.
- `ui/37-a11y-r3-830-*.png` are 1245x1289.
- `ui/37-a11y-r3-1440-*.png` are 2160x1350.

**Pinned by render tests.** These are `renderToStaticMarkup` tests: no DOM and no new dependency.
Each one failed before its fix:
- `KnowledgeView.test.ts`: `<main>` is `flex-none`, with no unprefixed `flex-1` or
  `overflow-y-auto`, and `lg:flex-1 lg:overflow-y-auto lg:min-h-0`. The rail has
  `max-h-[Nvh] lg:max-h-none`.
- `explore/ExploreView.test.ts`: the detail region is `shrink-0 h-[Nvh] min-h-[Nrem]`, with no
  unprefixed `flex-1`/`min-h-0`, and `lg:flex-1 lg:min-h-0 lg:h-auto`. The lists column is capped.
- `components/NodeHead.test.ts`: the root is `flex-none`, with no `flex-1` and no
  `overflow-y-auto`.

Tests can pin the classes but not the heights. The heights are the table above.

**401/403 (nonblocking findings).**
- `state/useListing.test.ts` drives the real hook through a tiny dispatcher-backed hook runner,
  with no DOM, over a stubbed `fetch` that returns the auth gate's own `{"error":"forbidden"}`
  (403) and `{"error":"unauthenticated"}` (401) bodies. It asserts
  `state.error === authErrorHint(code)` for peers, sessions and nodes. Reverting only
  `useListing.ts` to `06e5017` makes the 401 and 403 tests fail (2 fail, 1 pass; `Received: null`).
- Explore > Messages (`Transcript`) now shows the same hint as the list panels above it, inside
  `role="alert"`. It keys on the code's first word, because `describe()` appends ` at <pointer>`.
  The `ListPanel` error line is also `role="alert"`.
- The `forbidden` hint now names both possible causes: missing scope, or a token that is not
  bound to the peer the request names. The second is the R3 `transport.requireBoundPeers` refusal.

**Teardown.** The origin's `localStorage`/`sessionStorage` were cleared (length read back: 0) and
the device-metrics override was cleared. The TaskSpace was finished. The server got `kill -TERM`
(gone). `rm -rf` removed the mktemp root (`ls`: "No such file or directory"). No listener was left
on the port.

## Round 4 (after the verifier refuted round 3: sideways scrolling inside the views)

**What round 3 got wrong.** It checked only `document.documentElement.scrollWidth`. Round 3 made
each view's root the page's one scroll container, so horizontal overflow landed *inside* that
container, where the document's `scrollWidth` cannot see it. The claim "scrollWidth equals
innerWidth in all 3 views" was not evidence of no horizontal overflow. The verifier found three
sources on 72fce75: the "revision to correct" `<select>` (671px for a 114-char title), the diff
from/to `<select>`s (1219px for a 210-char title with a code path, sideways at 1440 too), and
`MessageRow` text with `whitespace-pre-wrap` and no overflow-wrap.

**The measurement now.** At every size, in every view, the script scans **every element** whose
computed `overflow-x` is `auto` or `scroll` and reports any with `scrollWidth > clientWidth`. It
also reports every element whose box leaves the viewport (`right > innerWidth`). The script is
`.tmp/measure-r4.mjs` in this worktree. It was run in real Chrome via `/ego-browser`
`page.evaluate`, and `innerWidth` was read back each time. The sandbox renders at DPR 1.5, so each
CDP override is the CSS width × 1.5.

**Control: the scan catches the bug.** The same scan, run on the round-3 bundle
(`index-vopEcGuI.js`) against the same dataset, reports the overflow:

| round-3 bundle | Knowledge | Explore > Messages | Messages | Forum | Overview |
|---|---|---|---|---|---|
| 320x640 | root 310 / **1496** | transcript 290 / **333**; `document` **359** ("refresh all" ends at 360) | 310 / **333** | 310 / **333** | root 310 / **336** |
| 375x812 | root 365 / **1496** | clean | clean | clean | clean |
| 1440x900 | `<main>` 790 / **1496** | clean | clean | clean | clean |

On that bundle the diff select measured 1312px wide, and the correct select 1415px.

**Round 4 bundle (`index-HFZYwyMh.js`).** Same dataset and same scan. Overflowing scrollers and
elements past the viewport were **0 / 0 in every cell**: 5 views × 5 sizes (320x640, 375x812,
812x375, 830x859, 1440x900). `document.scrollWidth` equalled `innerWidth` in every cell.

| CSS px | diff select width | correct select width | Knowledge: page scroller / NodeHead | Explore: lists / DetailTabs / transcript viewport (content) |
|---|---|---|---|---|
| 320x640 | 286 | 216 | 465 / 9189; 2275 = 2275 | 288 / 384 / 149 (2059) |
| 375x812 | 341 | 272 | 637 / 7116; 1579 = 1579 | 365 / 529 / 293 (2019) |
| 812x375 | 778 | 708 | 295 / 4842; 859 = 859 | 169 / 384 / 177 (1379) |
| 830x859 | 796 | 726 | 779 / 4842; 859 = 859 | 387 / 687 / 480 (1379) |
| 1440x900 | 766 | 696 | `<main>` 819 / 4332; 859 = 859 | 735 / 735 / 528 (1059) |

**The dataset.** A fresh `mktemp -d` stack was started with `app/just/demo/stack.sh`'s
`demo_stack_up` on a free port, with the model URL on a dead port. It was seeded through the
real CLI (`.tmp/r4stack.sh`):
- 12 peers and 12 sessions;
- 16 messages in `session-01`, the last containing
  `/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/app/server/src/knowledge/publishRevision.ts`;
- one node with two revisions, both with a 40-line Thai/English body. Revision 1 has a
  125-character Thai/English title. Revision 2 has a 241-character title that contains the same
  code path.

**Fixes.** Each is pinned by a failing-first `renderToStaticMarkup` test in
`components/reflow.test.ts`. The red output is in `.tmp/red-r4.txt`.
- Every `<select>` that can list a title is `min-w-0 max-w-full`: CorrectForm (also `flex-1`, in a
  `min-w-0` row), the diff pair, and LinkEditor's loaded-revision pick. The option text truncates
  instead of widening the view. The diff pair moved into `components/RevisionDiffPicker.tsx`, so a
  test can render it without a live node.
- `MessageRow` and `ThreadNode` (Forum) text gets `[overflow-wrap:anywhere]`, and so does the
  header line with the peer name. An unbroken path breaks mid-token (see the 320 screenshot).
- The scan at 320px found two more rows that the verifier's 375px pass could not see:
  - Explore's count strip now wraps (`flex-wrap`). Its "refresh all" button used to end at 360px.
  - The Overview probe grid is `minmax(min(20rem,100%),1fr)`, and its rows are
    `minmax(0,1fr)_auto_minmax(0,1.4fr)`. The old 7rem/9rem floors alone outgrew a 320px card.

**Nonblocking findings.**
- `ErrorNote` matches the first word of `message`, through the new `state/authErrorHintFromText.ts`,
  which `Transcript` shares. So `forbidden at /peer_name` now gets its hint in the App aside too.
  `Transcript` computes the hint once.
- The Explore lists column is a `<section aria-label="Peers and sessions">`. It used to be a
  `<div>`, and ARIA prohibits naming a generic element.
- `ListPanel` errors are `role="status"`. The transcript's is the one `role="alert"`, so a bad
  token no longer raises three assertive alerts with one sentence.
- Landscape: DetailTabs gained `max-h-full`. Scrolled into view, its tab bar, transcript and
  composer now fit on one screen wherever the 24rem floor fits (375x812: 529px in a 529px
  scroller). **Not fixed at 812x375.** The 24rem floor still wins there: 384px in a 211px
  scrollport, the same as round 3. It also wins at 320x640: 384px in a 357px scroller. I tried capping the floor too (`min(24rem,100%)`) and measured
  it: the pane fit in 211px, but the transcript viewport was **24px**, which is round 2's defect.
  So the floor stays.
- Not done: DetailTabs still has no `role=tab`/`aria-selected` and no roving focus. The tabs are
  native `<button>`s with the global `:focus-visible` ring.

**Screenshots** are named by CSS width, or width x height where the height matters. The PNG
pixel size is 1.5× the CSS size:
- `ui/37-a11y-r4-375-knowledge-diff.png` and `ui/37-a11y-r4-375-knowledge-correct.png`: the
  capped selects, with no horizontal scrollbar.
- `ui/37-a11y-r4-1440-knowledge-diff.png` and `ui/37-a11y-r4-1440-knowledge-correct.png`.
- `ui/37-a11y-r4-320x640-explore-messages.png`: the path wraps, and "refresh all" is on its own
  line.
- `ui/37-a11y-r4-375x812-explore-messages.png`, `ui/37-a11y-r4-812x375-explore-messages.png` and
  `ui/37-a11y-r4-320-overview.png`.

**Teardown.** The origin's `localStorage` and `sessionStorage` were cleared (length read back: 0),
and the device-metrics override was cleared. The TaskSpaces were finished. The server got
`kill -TERM` and is gone. `rm -rf` removed the mktemp root (`ls`: "No such file or directory"). No
listener was left on the port.

## Round 5 (after the wave-6 verifier refuted round 4: unbroken tokens with no wrap rule)

**What round 4 got wrong.** It wrapped message text in `MessageRow` and `ThreadNode` and measured
on a dataset with no links, no path in a node body, and the context panel collapsed. The verifier
found the same overflow in three places: `RevisionDiff`'s term/link `<li>`s (a link is
`JSON.stringify(entry)`, one token of ~230 chars; Knowledge scroller 310/984 at 320), `NodeHead`'s
body (`<pre>` and markdown `<p>`, `whitespace-pre-wrap` with no overflow-wrap), and
`ContextPanel`'s items (App `<aside>` 365/670 at 375).

**Fix: a sweep, not three patches.** Every element in `app/ui/v2/src` that renders text verbatim
now wraps: every className with `whitespace-pre*` or `font-mono` (ids, paths, digests, JSON), and
every `<pre>`/`<code>`, carries `[overflow-wrap:anywhere]` (or already had `truncate`/`break-*`);
form controls are exempt. 32 elements in 20 files, including `DialecticPanel`'s answer and
`TracePanel`'s excerpt (the two nonblocking sources). `RevisionDiff`'s term/link lists get
`anywhere` and the two grid halves `min-w-0`. `ContextPanel`'s item is split into
`components/ContextItemRow.tsx` so a test can render it without the "Show N items" click; its
header row now wraps (`flex-wrap min-w-0`) for a long peer name.

**Tests (failing first).** `components/reflowText.test.ts`: 6 `renderToStaticMarkup` tests pin
`[overflow-wrap:anywhere]` on the element holding each worst case (a 419-char link JSON in the
diff, a repo path and an absolute path in both body formats, a context item and its 64-char peer
name, the chat answer, a trace excerpt), plus a **source guard** that fails on any new
whitespace-pre*/font-mono/`<pre>`/`<code>` element without a wrap rule. This answers the verifier's
point that class-pinning tests cannot find an unfixed element. Red before the fix: 0 pass / 7 fail,
with the guard listing 34 offenders (`.tmp/red-r5.txt`). Mutant: dropping the rule from the link
`<li>` alone turns the link test red (`Received: [ "text-accent" ]`). Green: 7/7; UI suite
246 pass / 0 fail; UI and server `tsc` clean.

**Measurement: the verifier's own method.** `.tmp/measure-r5.mjs`, real Chrome via `/ego-browser`,
bundle `index-B2sPmb0C.js`. For every element in `body`, it reports `scrollWidth > clientWidth + 1`
and splits scrollers (`overflow-x` auto/scroll) from clipped boxes. It also reports every box past
the viewport and `document.scrollWidth` vs `innerWidth`.

The dataset was a fresh `mktemp -d` gated stack (`.tmp/r5stack.sh`, `demo_stack_up`, model URL on a
dead port). It held 12 peers and 12 sessions, and 16 messages in `session-01`, the last holding a
97-char absolute path. It had one node with two revisions. The head body holds
`app/server/src/knowledge/service.publishRevision.ts:120`, the absolute path, and a 159-char
GitHub URL. The head cites 3 links: `code`, `url` and `node_revision` → revision 1, so the diff
shows `links (3)`, with link JSON of 253, 337 and 392 chars. The context panel was **expanded**
(16 items).

| CSS px | Knowledge (body + diff) | Messages + context expanded | Explore > Messages | Forum | Overview | link `<li>` client / scroll | context `<p>` worst overflow |
|---|---|---|---|---|---|---|---|
| 320x640 | 0 / 0, doc 320 | 0 / 0, doc 320 | 0 / 0 | 0 / 0 | 0 / 0 | 124 / 124 | 0 px |
| 375x812 | 0 / 0, doc 375 | 0 / 0, doc 375 | 0 / 0 | 0 / 0 | 0 / 0 | 152 / 152 | 0 px |
| 830x859 | 0 / 0, doc 830 | 0 / 0, doc 830 | 0 / 0 | 0 / 0 | 0 / 0 | 379 / 379 | 0 px |
| 1440x900 | 0 / 0, doc 1440 | 0 / 0, doc 1440 | 0 / 0 | 0 / 0 | 0 / 0 | 364 / 364 | 0 px |

Cells read "overflowing scrollers / boxes past the viewport". `document.scrollWidth` equalled
`innerWidth` in all 20 cells. The only non-scroller boxes wider than their content are deliberate
clips: the token `<input>` (its own value), the `truncate`d revision-title `<span>`s in history,
and one `truncate`d probe method name at 320. The link `<li>`s now end at x=285 (320), 341 (375),
795 (830) and 1021 (1440). Before, the verifier measured x=1464–1480 in a column ending at 1046.

**Not measured live:** the chat answer (no chat model) and trace excerpts (no traces in the
dataset). Both are pinned by render tests and the guard only. 812x375 was not re-scanned this
round. The DetailTabs 24rem floor there is unchanged from round 4 (disclosed partial).

**Screenshots** (PNG is 1.5x the CSS size): `ui/39-a11y-r5-<width>-knowledge-body.png` (the paths
in the body break mid-token), `ui/39-a11y-r5-<width>-knowledge-diff-links.png` (the link JSON
wraps inside its half), and `ui/39-a11y-r5-<width>-messages-context.png` (the expanded context
items). Each exists for widths 320, 375, 830 and 1440.

**Teardown.** The origin's `localStorage` and `sessionStorage` were cleared (read back: 0 / 0) and
the device-metrics override was cleared. The TaskSpace was finished. The server got `kill -TERM`,
and nothing is left listening on its port. `rm -rf` removed the mktemp root (`ls`: "No such file or
directory").

**Live probe** (`run.sh … ui-a11y`): `methods=57 HTTP=57 MCP=57 CLI=57 isolation_failures=0
seed_errors=0 gaps=26 fatal=None`. Isolation is 191 pass / 0 fail, the same as round 4, and rc=2
from the 26 payload gaps, as in round 4. This slice touches no server code.
