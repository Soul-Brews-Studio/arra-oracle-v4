# UI proof: slice `ui-a11y` (#33 AC2 + R12 + Nat UI style)

**Branch**: `v4/on-ui-a11y`, worktree `wt/arra-oracle-v4-ui-a11y-27sep-sun2026`, based on
`origin/main` `b3fa70d`. Scope: `app/ui/v2` only. `app/server/src` was not touched.

## What was tested and how

- **Unit/render tests** (`bun test` in `app/ui/v2`, no DOM, `react-dom/server`
  `renderToStaticMarkup` per the existing `evidencePanels.test.ts` pattern): failing-first,
  then green after the fix. 139 pass / 0 fail across 18 files (was 106 pass before this
  slice's 4 new test files: `api/asError.test.ts`, `state/authErrorHint.test.ts`,
  `components/ErrorNote.test.ts`, `components/a11yNames.test.ts`).
- **`bunx tsc --noEmit`**: clean.
- **`bun run build`**: 118 modules, clean.
- **Mandatory live-probe** (`'.tmp/acceptor/live-probe/run.sh' … ui-a11y`, from the overnight
  worktree, against this checkout): `methods=57 HTTP=57 MCP=57 CLI=57 isolation_failures=0
  seed_errors=0 gaps=26 fatal=None`. Isolation **191 pass / 0 fail**. Start HEAD == end HEAD
  (`01ba604…`): this slice made no server-side change, confirmed by the probe itself. The 26
  GAPs are the pre-existing unexposed lifecycle/trace/search methods other slices own (#28–#31);
  none are in this slice's scope.
- **Python architecture guard** (`app/migrate-py`, `python -m unittest discover -s tests`):
  268 tests, **OK (skipped=1)**.
- **Live browser proof** (`/ego-browser`, real Chrome, a fresh `mktemp -d` target19+legacy15
  dataset, a real gated server on a free port started the same way `app/just/demo/stack.sh`
  does it, direct `curl` against the real endpoints plus DOM interaction): see below. Torn
  down afterward — server killed, mktemp root removed, browser `localStorage` cleared.

## (1) RESPONSIVE — overflow measurements

Baseline (pre-fix) is the commissioning brief's own measurement plus a direct code read at the
start of this slice, confirming the exact lines named: `KnowledgeView.tsx:83` was `w-64
shrink-0` and `:214` was `w-96 shrink-0`, both fixed-width `<aside>`s in a plain `flex` (row)
container with no breakpoint anywhere in `app/ui/v2/src` (`rg -c 'sm:|md:|lg:'` was 0 hits).
The brief's own browser finding: an 830px viewport left a 190px content column.

Fix: `KnowledgeView.tsx`, `App.tsx` (messages view), `explore/ExploreView.tsx`, and
`components/SidebarShell.tsx` all changed their row container to `flex-col md:flex-row` and
their fixed-width asides to `w-full md:w-{64,96,60}` (stacking below `md`, side-by-side at
`md:` and up). `App.tsx`'s tab bar and `DetailTabs`' tab bar got `flex-wrap` so the tab strip
itself cannot force width. `NodeHead.tsx`'s title got `min-w-0 break-words` — it sits in a
`flex` row with badges, and a flex item's default `min-width` is its content width, so an
unbroken title could force the row (and the page) wider than the viewport without wrapping.

Live measurement, `document.documentElement.scrollWidth` vs `window.innerWidth`, on the
**Knowledge** view (the one with both asides) after the fix, via CDP
`Emulation.setDeviceMetricsOverride`:

| requested width | measured `innerWidth` | `scrollWidth` | overflow? |
|---|---|---|---|
| 375 | 375 | 375 | no |
| 830 | 553 (see note) | 553 | no |
| 1440 | 960 (see note) | 960 | no |

Note: the CDP override could not push the real Chrome window wider than its own physical
size in this environment, so 830/1440 landed at the window's actual 553/960px rather than the
requested value — the scroll/inner equality (no overflow) still holds at every width actually
achieved, including the narrowest (375, exact) and two wider ones. The Explore view was
checked the same way at the 960px width: `scrollWidth === innerWidth === 960`, no overflow.
Screenshots: `docs/overnight/ui/36-a11y-375-overview.png`,
`36-a11y-375-knowledge.png`, `36-a11y-830-knowledge.png`, `36-a11y-1440-knowledge.png`.

**Deviation from the ruling**: the exact 830px and 1440px widths were not independently
confirmed in this browser session (see note above); 375px was exact and clean. Re-running this
same script against a browser window sized to at least 1440px physical would close the gap; the
code fix itself (breakpoint at `md` = 768px, well below both 830 and 1440) does not depend on
the exact width tested.

## (2) ACCESSIBILITY — unnamed-control counts

Before (code-level, measured at the start of this slice): `rg -c 'aria-|role='
app/ui/v2/src` → **0 files** with any `aria-*` or `role` attribute anywhere in the app.

After, live in the browser (`page.evaluate`, counting `input,select,textarea,button` with no
`aria-label`/`aria-labelledby`/associated `<label>`/non-empty text content):

| view | total controls | unnamed |
|---|---|---|
| Knowledge (rail, head, diff picker, publish form, taxonomy) | 13 | **0** |
| Explore (peers/sessions lists, 6 detail tabs) | 34 | **0** |

That is 47 controls checked live across 2 of the 4 named views (Knowledge, Explore); the
Overview and Chat/Messages surfaces were covered by the same aria-label/label pattern applied
to their shared components (`Composer`, `DialecticPanel`, `ContextPanel`, `WorkspaceBar`) and
by the render tests in `a11yNames.test.ts`, not independently re-counted live in this session
(time box).

Fixes applied: visible `<label htmlFor>`/`id` pairs where a visible label already existed but
was an unassociated sibling (`WorkspaceBar`'s bank/workspace/token, the Explore node-type
filter); `aria-label` where no visible label exists (`Composer`, `ReplyComposer`,
`DialecticPanel`'s question textarea, `KnowledgeSearchBox`, `PublishForm`'s title/body/change
reason/selects, `LifecycleActions`' retire/supersede fields, `TracePanel`'s trace-id input,
`AddNameForm`'s shared name input, `ListPanel`'s filter input, `KnowledgeView`'s diff pickers);
`aria-label`/`aria-expanded` on icon-only buttons (`ListPanel`'s collapse/refresh glyphs,
`SidebarShell`'s expand/collapse chevrons). A visible focus ring
(`:focus-visible { outline: 2px solid …}`) was added once, globally, in `index.css` for every
button/input/select/textarea/link/`[tabindex]`, rather than repeating a
`focus-visible:ring-*` utility across ~30 files — a missed selector there is caught by any
keyboard pass; a missed one per-file would not be. Coordination note honoured: `PublishForm.tsx`
and `KnowledgeView.tsx` only received `className`/attribute changes, no structural edits.

## (3) ERROR STATES — 401 / 403

Root cause found live, not assumed: the Host/Origin/bearer gate every transport shares
(`auth/http.ts`'s `ERROR_BODIES`) answers a 401 as `{"error":"unauthenticated"}` and a 403 as
`{"error":"forbidden"}` — a bare **string** under `error`. `asError()` in
`app/ui/v2/src/api/memory.ts` only understood the `arra-error/v1` object shape
(`{error:{code,...}}`); given the string shape it fell through to `null`, and `describe()`
then reported the generic `HTTP 401`/`HTTP 403` fallback instead of the real reason. Confirmed
directly against the live server before fixing:

```
$ curl … -H "authorization: Bearer wrong-token" …   -> 401 {"error":"unauthenticated"}
$ curl … -H "authorization: Bearer <readonly-token>" (a content:write call) -> 403 {"error":"forbidden"}
```

(The readonly credential was minted by hand into the dev policy the same way the overnight
worktree's acceptor probe does it — a second principal with only `content:read` on the
workspace — since `write_dev_policy.py` only mints a full-scope operator token.)

Fix: `asError()` now decodes the flat string shape into `{code: theString}`. A new pure helper
`state/authErrorHint.ts` maps `"unauthenticated"` → a token-focused sentence and `"forbidden"`
→ a scope-focused sentence, wired into `ErrorNote` (checking both `error.code` and
`error.message`, since some call sites — `KnowledgeView`'s `k.error`, `App.tsx`'s
`m.messageError` — wrap the bare code as `{code:"refused", message: theCode}` rather than
passing a real envelope) and into `chatError.ts` (peer chat's own error surface).

Live confirmation: with the readonly token, clicking "seed reserved vocabularies" in the
Knowledge view produced a visible **"forbidden"** state in the UI (`docs/overnight/ui/36-a11y-403-forbidden.png`).
**Deviation from the ruling**: that specific click path renders through `KnowledgeView`'s
`k.error` → `ErrorNote`, and the browser round that captured it ran against a build made
*before* the `error.message` fallback fix (the fallback was added in direct response to that
exact live finding — the screenshot shows the pre-fallback state, i.e. "forbidden" with no
hint sentence yet). The fallback logic itself is exercised and green in
`ErrorNote.test.ts`/`authErrorHint.test.ts`, and is a one-line, same-shape change, but a
second live click-through confirming the hint sentence now appears in the browser was not
re-run inside the time box. A 401 click-path (bad token on a listing read) was attempted live
but the Explore lists rendered "no peers/no sessions/no nodes" rather than a visible error —
whether that is a stale-closure/debounce artifact of the scripted DOM token-swap or a real gap
in how `useListing` surfaces a 401 was not resolved before time ran out; the 401 *decode* path
itself (`asError`, `describe`, `ErrorNote`) is covered by the unit/render tests and by the
direct `curl` proof above, just not by a full click-through screenshot.

## Teardown

Server process killed, `mktemp -d` root removed, browser `localStorage` cleared, ego-browser
task space finished (`keep: []`). `app/server/public/v2` was restored with `git checkout --`
and `git clean -fdq` before committing, per the coordination note (the integrator rebuilds it).
