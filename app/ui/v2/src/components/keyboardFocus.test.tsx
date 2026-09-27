/** Failing-first DOM tests (#33 AC2, ui-keys fix round): the focus MOVES
 *  the static render tests in `keyboardNav.test.ts` cannot see. Round 1
 *  pinned only markup and the pure `rovingKey`; the verifier showed the
 *  arrow handlers wired into `TabStrip`/`ListPanel` and `NodeHead`'s focus
 *  effect were covered by the ego-browser keyboard segment alone, which CI
 *  does not run. These mount the real components through `react-dom/client`
 *  on the shared fake DOM (`testing/installFakeDom.ts`, which models
 *  `focus()`/`activeElement`/`closest` for exactly this) and call the key
 *  handlers React rendered.
 *
 *  Pinned:
 *  - `TabStrip`: ArrowRight/End move focus to the right tab WITHOUT
 *    activating it (manual activation); the button's click is activation.
 *  - `ListPanel`: ArrowDown/ArrowUp/End move focus between rows, wrapping;
 *    Enter is left to the native button.
 *  - `NodeHead`: opening a node takes focus to its <h2> when focus was lost
 *    or sat outside <main> (a rail entry) -- but NOT off a role=tab (the
 *    WAI-ARIA tabs pattern keeps focus on the tab you activated), and never
 *    out of a control inside <main>.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom } from "../testing/installFakeDom";
import { findFakeElement } from "../testing/findFakeElement";
import { TabStrip } from "./TabStrip";
import { NodeHead } from "./NodeHead";
import { ListPanel } from "../explore/ListPanel";

type El = { tagName: string; getAttribute: (k: string) => string | null; appendChild: (c: unknown) => unknown; focus: () => void };

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

function mount(node: React.ReactNode) {
  const dom = installFakeDom();
  cleanup.push(dom.uninstall);
  let root: Root | null = null;
  act(() => {
    root = createRoot(dom.container);
    root.render(node);
  });
  cleanup.push(() => act(() => root?.unmount()));
  const doc = document as unknown as { activeElement: El | null; body: El; createElement: (t: string) => El };
  const find = (pred: (e: { tagName: string; textContent: string; getAttribute: (k: string) => string | null }) => boolean) => {
    const el = findFakeElement(dom.container, pred);
    if (el === null) throw new Error("element not rendered");
    return el;
  };
  const key = (pred: Parameters<typeof find>[0], k: string) => {
    let prevented = false;
    act(() => find(pred).props.onKeyDown!({ key: k, preventDefault: () => { prevented = true; } }));
    return prevented;
  };
  return { dom, doc, find, key, rerender: (n: React.ReactNode) => act(() => root!.render(n)) };
}

const focusedAttr = (name: string) => (document as unknown as { activeElement: El | null }).activeElement?.getAttribute(name) ?? null;

describe("TabStrip arrow keys move focus, not selection", () => {
  test("ArrowRight / End / Home focus the right tab; onActivate only on the button's click", () => {
    const activated: string[] = [];
    const m = mount(<TabStrip<string> label="t" idBase="t" tabs={["a", "b", "c"]} active="b" onActivate={(t) => activated.push(t)} />);
    const tab = (id: string) => (e: { getAttribute: (k: string) => string | null }) => e.getAttribute("id") === `t-tab-${id}`;
    expect(m.key(tab("b"), "ArrowRight")).toBe(true);
    expect(focusedAttr("id")).toBe("t-tab-c");
    m.key(tab("c"), "ArrowRight");
    expect(focusedAttr("id")).toBe("t-tab-a");
    m.key(tab("a"), "End");
    expect(focusedAttr("id")).toBe("t-tab-c");
    expect(m.key(tab("c"), "Enter")).toBe(false);
    expect(activated).toEqual([]);
    act(() => m.find(tab("c")).props.onClick!({}));
    expect(activated).toEqual(["c"]);
  });
});

describe("ListPanel rows: arrows move between rows, wrapping", () => {
  test("ArrowDown, ArrowUp, End and wrap; Enter left to the button", () => {
    const m = mount(
      <ListPanel<string>
        label="peers" rows={["alice", "bob", "carol"]} rowKey={(r) => r} renderRow={(r) => r}
        selectedKey={null} onSelect={() => {}} loading={false} error={null} supported total={null}
        pageIndex={0} hasNext={false} hasPrev={false} onNext={() => {}} onPrev={() => {}} onRefresh={() => {}}
      />,
    );
    const row = (k: string) => (e: { getAttribute: (k: string) => string | null }) => e.getAttribute("data-row") === k;
    m.key(row("alice"), "ArrowDown");
    expect(focusedAttr("data-row")).toBe("bob");
    m.key(row("bob"), "ArrowUp");
    expect(focusedAttr("data-row")).toBe("alice");
    m.key(row("alice"), "ArrowUp");
    expect(focusedAttr("data-row")).toBe("carol");
    m.key(row("carol"), "Home");
    expect(focusedAttr("data-row")).toBe("alice");
    m.key(row("alice"), "End");
    expect(focusedAttr("data-row")).toBe("carol");
    expect(m.key(row("carol"), "Enter")).toBe(false);
    expect(focusedAttr("data-row")).toBe("carol");
  });
});

const REV = (id: string, title: string) =>
  ({
    id,
    title,
    body: "b",
    body_format: "text",
    revision_no: 1,
    is_active: true,
    created_at: "2026-09-27T00:00:00Z",
    content_digest: "abcdef0123456789",
    term_snapshot_json: "[]",
  }) as never;

describe("NodeHead moves focus to the opened node's title only when it should", () => {
  const head = (node: string, rev: string) => <NodeHead node={{ node_id: node }} revision={REV(rev, `title ${node}`)} loading={false} error={null} />;
  /** Focus something the test builds, outside the mounted tree, THEN mount. */
  function openWith(focus: (doc: { body: El; createElement: (t: string) => El }) => El | null) {
    const dom = installFakeDom();
    cleanup.push(dom.uninstall);
    const doc = document as unknown as { activeElement: El | null; body: El; createElement: (t: string) => El };
    const before = focus(doc);
    doc.activeElement = before;
    let root: Root | null = null;
    act(() => {
      root = createRoot(dom.container);
      root.render(head("n1", "r1"));
    });
    cleanup.push(() => act(() => root?.unmount()));
    return { before, doc, rerender: (n: React.ReactNode) => act(() => root!.render(n)) };
  }

  test("focus lost (nothing / <body>): the <h2> takes it", () => {
    expect(openWith(() => null).doc.activeElement?.tagName).toBe("H2");
    expect(openWith((d) => d.body).doc.activeElement?.tagName).toBe("H2");
  });

  test("a node-rail entry outside <main> had focus: the <h2> takes it", () => {
    const o = openWith((d) => d.body.appendChild(d.createElement("button")) as El);
    expect(o.doc.activeElement?.tagName).toBe("H2");
  });

  test("a role=tab had focus (the view tab just activated): focus STAYS on the tab", () => {
    const o = openWith((d) => {
      const tab = d.createElement("button");
      (tab as unknown as { setAttribute: (k: string, v: string) => void }).setAttribute("role", "tab");
      return d.body.appendChild(tab) as El;
    });
    expect(o.doc.activeElement).toBe(o.before);
  });

  test("a control inside <main> had focus: never pulled away", () => {
    const o = openWith((d) => {
      const main = d.body.appendChild(d.createElement("main")) as El;
      return main.appendChild(d.createElement("input")) as El;
    });
    expect(o.doc.activeElement).toBe(o.before);
  });

  test("a new revision of the SAME node takes focus only if focus was lost", () => {
    const o = openWith((d) => d.body.appendChild(d.createElement("button")) as El);
    const rail = o.doc.createElement("button");
    o.doc.activeElement = rail;
    o.rerender(head("n1", "r2"));
    expect(o.doc.activeElement).toBe(rail);
    o.doc.activeElement = o.doc.body;
    o.rerender(head("n1", "r3"));
    expect(o.doc.activeElement?.tagName).toBe("H2");
  });
});
