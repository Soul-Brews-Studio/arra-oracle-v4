/** Failing-first RENDER tests (#33 AC2, ui-keys slice): every tab strip is a
 *  WAI-ARIA tabs widget and the list panels are keyboard-operable.
 *
 *  Pinned here:
 *  - `TabStrip`: role=tablist/tab, aria-selected on the active tab only, a
 *    roving tabindex (0 on the active tab, -1 on the rest), aria-controls
 *    naming the one tabpanel;
 *  - `DetailTabs` (Explore) renders that strip plus a role=tabpanel whose
 *    aria-labelledby is the active tab's id;
 *  - `rovingKey`: ArrowLeft/ArrowRight (or Up/Down) wrap, Home/End jump, and
 *    any other key (Enter, Space, Tab) is left to the browser -- activation
 *    is MANUAL: arrows move focus, the native button's Enter/Space activates;
 *  - `ListPanel`: rows are real buttons, the selected row says so with
 *    aria-current, and the arrow keys move between rows;
 *  - `NodeHead`: the node title is a focus target (tabindex=-1) so opening a
 *    node can move focus to it instead of losing it to <body>.
 *  `renderToStaticMarkup`, no DOM, per `evidencePanels.test.ts`'s precedent.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabStrip } from "./TabStrip";
import { rovingKey } from "./rovingKey";
import { NodeHead } from "./NodeHead";
import { DetailTabs } from "../explore/DetailTabs";
import { ListPanel } from "../explore/ListPanel";
import { exploreTabOf } from "../explore/exploreTabOf";
import { RosterEntryRow } from "./RosterEntryRow";

const attrs = (html: string, role: string) =>
  [...html.matchAll(new RegExp(`<[a-z]+[^>]*role="${role}"[^>]*>`, "g"))].map((m) => m[0]);
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;

describe("TabStrip is a WAI-ARIA tabs widget", () => {
  const html = renderToStaticMarkup(
    createElement(TabStrip, {
      label: "Views",
      idBase: "v",
      tabs: ["one", "two", "three"],
      active: "two",
      onActivate: () => {},
    }),
  );
  const tabs = attrs(html, "tab");

  test("one tablist with an accessible name, one tab per entry", () => {
    const lists = attrs(html, "tablist");
    expect(lists).toHaveLength(1);
    expect(attr(lists[0]!, "aria-label")).toBe("Views");
    expect(tabs).toHaveLength(3);
  });

  test("aria-selected is true on the active tab only", () => {
    expect(tabs.map((t) => attr(t, "aria-selected"))).toEqual(["false", "true", "false"]);
  });

  test("roving tabindex: 0 on the active tab, -1 on every other", () => {
    expect(tabs.map((t) => attr(t, "tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  test("each tab has an id and controls the one panel", () => {
    expect(tabs.map((t) => attr(t, "id"))).toEqual(["v-tab-one", "v-tab-two", "v-tab-three"]);
    expect(new Set(tabs.map((t) => attr(t, "aria-controls")))).toEqual(new Set(["v-panel"]));
  });
});

describe("DetailTabs (Explore) uses the tabs pattern end to end", () => {
  const html = renderToStaticMarkup(
    createElement(DetailTabs, {
      active: "config",
      onChange: () => {},
      config: { taxonomy: null, seeded: false, onSeed: () => {}, busy: false, error: null },
    } as unknown as Parameters<typeof DetailTabs>[0]),
  );

  test("six tabs, config selected and the only tab stop", () => {
    const tabs = attrs(html, "tab");
    expect(tabs).toHaveLength(6);
    const selected = tabs.filter((t) => attr(t, "aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(attr(selected[0]!, "id")).toBe("explore-detail-tab-config");
    expect(tabs.filter((t) => attr(t, "tabindex") === "0")).toEqual(selected);
  });

  test("the tabpanel is labelled by the active tab and is what the tabs control", () => {
    const panels = attrs(html, "tabpanel");
    expect(panels).toHaveLength(1);
    expect(attr(panels[0]!, "aria-labelledby")).toBe("explore-detail-tab-config");
    expect(attr(panels[0]!, "id")).toBe("explore-detail-panel");
  });
});

describe("rovingKey: arrows move focus, Enter/Space are left to the native button", () => {
  const run = (key: string, index: number, orientation: "horizontal" | "vertical" = "horizontal") => {
    let focused = -1;
    let prevented = false;
    const items = [0, 1, 2, 3].map((i) => ({ focus: () => { focused = i; } }));
    const handled = rovingKey({ key, preventDefault: () => { prevented = true; } }, index, items, orientation);
    return { handled, focused, prevented };
  };

  test("ArrowRight moves to the next tab and wraps from the last", () => {
    expect(run("ArrowRight", 1)).toEqual({ handled: true, focused: 2, prevented: true });
    expect(run("ArrowRight", 3).focused).toBe(0);
  });

  test("ArrowLeft moves to the previous tab and wraps from the first", () => {
    expect(run("ArrowLeft", 2).focused).toBe(1);
    expect(run("ArrowLeft", 0).focused).toBe(3);
  });

  test("Home and End jump to the ends", () => {
    expect(run("Home", 2).focused).toBe(0);
    expect(run("End", 0).focused).toBe(3);
  });

  test("vertical lists use ArrowUp/ArrowDown instead", () => {
    expect(run("ArrowDown", 3, "vertical").focused).toBe(0);
    expect(run("ArrowUp", 1, "vertical").focused).toBe(0);
    expect(run("ArrowRight", 1, "vertical").handled).toBe(false);
  });

  test("Enter, Space and Tab are not handled (native activation and tab order)", () => {
    for (const key of ["Enter", " ", "Tab"]) {
      expect(run(key, 1)).toEqual({ handled: false, focused: -1, prevented: false });
    }
  });
});

describe("ListPanel rows are keyboard-operable and announce selection", () => {
  const html = renderToStaticMarkup(
    createElement(ListPanel<string>, {
      label: "peers",
      rows: ["alice", "bob", "carol"],
      rowKey: (r: string) => r,
      renderRow: (r: string) => r,
      selectedKey: "bob",
      onSelect: () => {},
      loading: false,
      error: null,
      supported: true,
      total: null,
      pageIndex: 0,
      hasNext: false,
      hasPrev: false,
      onNext: () => {},
      onPrev: () => {},
      onRefresh: () => {},
    }),
  );
  const rows = [...html.matchAll(/<button[^>]*data-row="[^"]*"[^>]*>/g)].map((m) => m[0]);

  test("every row is a type=button in the tab order", () => {
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(attr(r, "type")).toBe("button");
      expect(attr(r, "tabindex")).toBeNull();
    }
  });

  test("only the selected row carries aria-current", () => {
    expect(rows.map((r) => attr(r, "aria-current"))).toEqual([null, "true", null]);
  });

  test("the rows sit in a named list group", () => {
    const groups = attrs(html, "group");
    expect(groups.some((g) => attr(g, "aria-label") === "peers rows")).toBe(true);
  });
});

describe("NodeHead's title is a programmatic focus target", () => {
  test("the h2 has tabindex=-1 so focus can land on it after navigation", () => {
    const html = renderToStaticMarkup(
      createElement(NodeHead, {
        node: { node_id: "n1" },
        revision: {
          id: "r1",
          title: "Title here",
          revision_no: 1,
          created_at: "2026-09-27T00:00:00Z",
          content_digest: "abcdef0123456789",
          term_snapshot_json: "[]",
        } as never,
        loading: false,
        error: null,
      }),
    );
    const h2 = html.match(/<h2[^>]*>/)?.[0] ?? "";
    expect(attr(h2, "tabindex")).toBe("-1");
  });
});

// Fix round (verifier finding, blocking): a route `tab` that is not one of
// the strip's tabs -- a hand-typed `&tab=Nodes` (the labels are CSS-
// capitalised), a stale link -- left EVERY tab at tabindex=-1, so the strip
// could not be reached with Tab at all. WAI-ARIA APG: with no tab selected,
// the FIRST tab is the tab stop.
describe("a tab strip with no matching active tab keeps one tab stop", () => {
  const strip = (active: string) =>
    attrs(
      renderToStaticMarkup(
        createElement(TabStrip<string>, { label: "Views", idBase: "v", tabs: ["one", "two", "three"], active, onActivate: () => {} }),
      ),
      "tab",
    );

  test("unknown active: the first tab is the only tab stop and nothing is aria-selected", () => {
    for (const active of ["bogus", "Two", ""]) {
      const tabs = strip(active);
      expect(tabs.map((t) => attr(t, "tabindex"))).toEqual(["0", "-1", "-1"]);
      expect(tabs.map((t) => attr(t, "aria-selected"))).toEqual(["false", "false", "false"]);
    }
  });

  test("DetailTabs rendered with a stale route tab ('Nodes') still has exactly one tab stop", () => {
    const html = renderToStaticMarkup(
      createElement(DetailTabs, {
        active: "Nodes",
        onChange: () => {},
        config: { taxonomy: null, seeded: false, onSeed: () => {}, busy: false, error: null },
      } as unknown as Parameters<typeof DetailTabs>[0]),
    );
    const stops = attrs(html, "tab").filter((t) => attr(t, "tabindex") === "0");
    expect(stops.map((t) => attr(t, "id"))).toEqual(["explore-detail-tab-nodes"]);
  });

  test("App's route coercion: an unknown or missing route tab opens 'nodes', a known one passes through", () => {
    for (const bad of ["Nodes", "bogus", "", null]) expect(exploreTabOf(bad)).toBe("nodes");
    for (const ok of ["nodes", "search", "chat", "messages", "evidence", "config"] as const) expect(exploreTabOf(ok)).toBe(ok);
  });
});

describe("rail rows (peer, session, node bookmarks) announce the selected row", () => {
  const row = (selected: boolean) =>
    renderToStaticMarkup(
      createElement(RosterEntryRow, {
        entry: { name: "alice", state: "live" } as never,
        selected,
        onSelect: () => {},
        onRemove: () => {},
        onRegister: () => {},
        registerLabel: "register",
        busy: false,
      }),
    ).match(/<button[^>]*>/)?.[0] ?? "";

  test("the select button carries aria-current only when selected", () => {
    expect(attr(row(true), "aria-current")).toBe("true");
    expect(attr(row(false), "aria-current")).toBeNull();
  });
});

// Fix round (verifier, nonblocking): `h-screen` is 100vh, the LARGE viewport
// on a mobile landscape browser -- the composer could sit under the
// toolbar. The `short` layout pins to 100svh (the small viewport) instead.
describe("the short-landscape layout sizes to the small viewport", () => {
  test("DetailTabs' pane uses short:h-svh, never short:h-screen", () => {
    const html = renderToStaticMarkup(
      createElement(DetailTabs, {
        active: "config",
        onChange: () => {},
        config: { taxonomy: null, seeded: false, onSeed: () => {}, busy: false, error: null },
      } as unknown as Parameters<typeof DetailTabs>[0]),
    );
    const section = html.match(/<section[^>]*aria-label="Explore detail"[^>]*>/)?.[0] ?? "";
    expect(section).toContain("short:h-svh");
    expect(section).not.toContain("short:h-screen");
  });
});
