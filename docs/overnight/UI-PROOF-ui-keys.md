# UI proof: ui-keys (#33 AC2, keyboard navigation and narrow layouts)

Slice `ui-keys`, branch `v4/on-ui-keys`, base `d949290`. The ruling is in `docs/overnight/DECISIONS.md`
(#33 AC2; R12 sets the model split). The contract amendment is in
`app/docs/contracts/delivery-gates.md`, "Amendment 2026-09-26 (post-merge #33 AC2 ...)".

## What changed

- **Tab strips** (`app/ui/v2/src/components/TabStrip.tsx`, used by the app view tabs in `App.tsx`
  and by Explore `DetailTabs`): WAI-ARIA tabs. They have `role=tablist/tab/tabpanel`,
  `aria-selected`, `aria-controls`, and `aria-labelledby` on the panel. The tabindex roves: the
  active tab is the only Tab stop.
  - **Activation is manual everywhere.** ArrowLeft/ArrowRight/Home/End move focus only
    (`rovingKey.ts`). Enter/Space on the focused tab activates it through the native `<button>`.
  - **Why manual:** arrowing across Explore's six tabs does not push six history entries or fire
    six fetches.
- **List panels** (peers, sessions, Explore nodes; `ListPanel.tsx`): rows stay native
  `type=button` elements in the Tab order, so a Tab-only user reaches every row. Enter/Space
  activate.
  - This is deliberately not a roving tabindex. ArrowUp/ArrowDown/Home/End also move between rows,
    as a shortcut.
  - The selected row has `aria-current=true`. The rows sit in `role=group` named "<label> rows".
- **Focus after navigation** (`NodeHead.tsx`): the node title `<h2 tabindex=-1>` takes focus in
  two cases:
  - A node is opened while focus is outside `<main>` (node rail, view tabs, search hit).
  - Focus was lost to `<body>`.
- **Defect found by the keyboard run and fixed:** after "publish revision" the form clears and its
  button turns disabled under the focus. Focus fell to `<body>` (`STEP_FAIL keys-publish-and-revise:
  focus lost to <body> after publish revision`). It now lands on the node's heading.
- **Focus visibility:** unchanged. `index.css` already rings every `button/input/select/textarea/a/[tabindex]`
  on `:focus-visible`, which covers the new tabs, rows and the `h2`.
- **812x375:** a `short` screen in `tailwind.config.js` (`(max-height: 500px) and (max-width: 1023.98px)`).
  - There the shell is no longer pinned to the viewport (`App.tsx`: `short:h-auto short:min-h-screen`),
    so the header and tabs scroll away and the document scrolls.
  - The Explore detail pane is exactly one viewport tall, with no 24rem floor (`short:h-screen short:min-h-0`).
  - The messages-view `<main>` is also one viewport (`short:h-screen`).

## Failing-first render tests

`app/ui/v2/src/components/keyboardNav.test.ts` has 15 tests: TabStrip roles, aria-selected, the
roving tabindex, aria-controls, DetailTabs tabpanel/aria-labelledby, rovingKey arrows, Home/End,
wrap and vertical, Enter/Space/Tab not handled, ListPanel `type=button`/aria-current/group, and the
NodeHead `h2 tabindex=-1`.

- **Red before the fix** (inert stubs, so the red is the assertions, not a missing module): 1 pass / 14 fail.
- **Green after:** 15 pass. The whole `app/ui/v2` suite: 314 pass / 0 fail.
- **Mutants, each shown red then restored:**
  - TabStrip `tabIndex={0}` on every tab: 2 fail (roving tabindex, DetailTabs "only tab stop").
  - rovingKey without wrap (`Math.min(index + 1, n - 1)`): 2 fail (ArrowRight wrap, vertical wrap).
- `app/just/ui-e2e.test.ts` checks statically that `keys.mjs`/`keyNav.mjs` never `.click(`,
  `.focus(`, `h.act(`, `h.go(`, set `.value =`, `dispatchEvent`, `page.press(`, set
  `location.hash =`, or `insertText`. It also checks that input goes only through
  `page.keyboard.press/type`.

## Keyboard run (real keyboard, ego-browser `page.keyboard` only)

Command: `UI_E2E_NO_BUILD=1 bash app/just/ui-e2e-keys.sh <out>`. Omit `UI_E2E_NO_BUILD` to rebuild
first. `ui-e2e.sh` runs the same segment after the form-driven chain, because `UI_E2E_SEGMENT`
defaults to `all`.

Run 2026-09-27, Chromium via ego-browser, fresh mktemp dataset and server:

```
E2E_START
E2E_SPACE 278
STEP_OK ui-open http://127.0.0.1:50467/v2/ (token set in localStorage, never in a URL)
STEP_OK keys-start #/overview reloaded, focus on <body>
STEP_OK keys-view-tabs Tab x5 to the view tablist; ArrowRight/End/Home/ArrowLeft move focus only; Enter opened explore
STEP_OK keys-open-peer Tab x6 to row alice; ArrowDown -> bob, ArrowUp back; Enter opened it (aria-current=true)
STEP_OK keys-open-session Tab x6 to row daily-loop; Space opened it
STEP_OK keys-detail-tabs Tab x2 to the detail tablist; End/Home/ArrowRight x3 then Enter -> messages tabpanel
STEP_OK keys-send-message Tab x3 to the composer; typed + Control+Enter; "keyboard hello llh19r" is in the transcript
STEP_OK keys-open-knowledge Shift+Tab x17 back to the view tablist; End + Enter -> knowledge; vocab seeded by Tab + Enter
STEP_OK keys-publish-and-revise A=DqsMmYnQaRs6pxQ7jZBgN created then revised to #2; focus after create: H2:Keyboard node llh19r, after revise: H2:Keyboard node llh19r
STEP_OK keys-cite B=WQTDDdGJtVkzArJbWxxHD cites A#2 (ygrUnd3W…), picked by type-ahead "#2 — Keyboard node llh19r v2 ("
STEP_OK keys-correct Shift+Tab x4 to A in the node rail, Enter -> focus on A's <h2>; C=xeszWaAwTKbWmFyhYnBpC corrects A#2; focus now H2:Keyboard correction llh1
STEP_OK keys-supersede A superseded by C (EYYbjZ6Q…) from Explore > evidence, ids typed
STEP_OK keys-read-history knowledge opened with focus on A's <h2> (true); Tab x3 to history #1, Enter -> diff from rev 1 "Keyboard node llh19r"
STEP_OK keys-narrow-812x375 {"vw":812,"vh":375,"docScroll":709,"overflowX":false,"pane":{"top":0,"bottom":376,"h":375},"tablist":{"top":0,"bottom":37,"h":37},"transcript":{"h":168},"textarea":{"top":251,"bottom":324,"h":73},"send":{"top":338,"bottom":364,"h":25}}
E2E_SUMMARY failures=0 screenshots=0
E2E_DRIVER_DONE
UI_E2E_RESULT PASS ok=14 fail=0 skip=0
TEARDOWN origin http://127.0.0.1:50467 storage keys before=4 after=0
TEARDOWN space 278 finished {"spaceId":278,"closedSpace":true,...}
+ rm -rf /var/folders/.../arra-demo.5J8rAi
```

This segment takes no screenshots. The harness rule is unchanged: in the full `ui-e2e.sh` run a
failed screenshot is still a `STEP_FAIL`, never a pass. The keyboard steps are judged on their DOM
and `document.activeElement` assertions alone.

## 812x375 measurements

**Before**, on `d949290` (measured by the earlier slices and recorded in the `DetailTabs.tsx`
comment):
- The detail pane had a 24rem (384px) floor inside a 211px page scrollport, so the tab bar,
  transcript and composer never fit on one screen.
- Capping the floor instead left the transcript 24px tall.

**After** (`keys-narrow-812x375`, above; values in CSS px):
- **Viewport:** `innerWidth x innerHeight` = 812 x 375. The emulated metrics are scaled by ego's
  per-origin zoom so that the CSS viewport really is 812 x 375.
- **Pane:** the Explore detail pane is 375 tall, i.e. exactly one viewport.
- **Pane contents, scrolled to:**

  | Part | Top | Bottom | Height |
  |---|---|---|---|
  | Tab bar | 0 | 37 | |
  | Transcript | | | 168 |
  | Composer textarea | 251 | 324 | |
  | Send button | 338 | 364 | |

- **Page:** no horizontal overflow; the document is 709px tall.
- **Usability:** a message was typed and sent (Control+Enter) at this size, and appeared in the
  transcript.

**Not measured in this run:** the Messages view (`#/messages`) at 812x375. Its `<main>` gets the same
`short:h-screen` treatment, but only Explore > messages was measured.
