// #33 AC2 ui-keys fix round: the stale-tab regression the verifier found,
// proved by keyboard. A hand-typed link with a `tab` no strip has
// (`&tab=Nodes` -- the labels are CSS-capitalised, so that is a natural
// guess) left every Explore detail tab at tabindex=-1: Tab cycled the whole
// page and never reached the strip.
//
// The ONE non-keyboard input here is the navigation itself, standing in for
// the user typing that link into the address bar (`h.go` + a reload so focus
// starts on <body>). Everything after it is `keyNav`: Tab to the strip,
// ArrowRight + Enter to repair the URL. Kept out of keys.mjs so that file's
// "no hash navigation" static check (ui-e2e.test.ts) still holds whole.
import { keyNav } from "./keyNav.mjs";

export async function keysStaleTab(h, cfg) {
  const k = keyNav(h);
  await h.step("keys-stale-tab", async () => {
    const link = `#/explore?peer=${encodeURIComponent(cfg.peer)}&session=${encodeURIComponent(cfg.session)}&tab=Nodes`;
    await h.go(link);
    await h.page.reload({ waitUntil: "load", timeout: 30000 });
    await h.ensureViewport();
    await h.waitDom("explore with tab=Nodes, focus on <body>", () =>
      location.hash.includes("tab=Nodes") && document.querySelectorAll('[id^="explore-detail-tab-"]').length === 6 && document.activeElement === document.body);
    const stops = await h.page.evaluate(() => [...document.querySelectorAll('[id^="explore-detail-tab-"]')].filter((t) => t.getAttribute("tabindex") === "0").map((t) => t.id));
    if (stops.length !== 1) throw new Error(`explore detail tab stops: ${JSON.stringify(stops)} (want exactly one)`);
    const r = await k.tabTo({ idStarts: "explore-detail-tab-" }, { max: 80 });
    if (r.d.id !== "explore-detail-tab-nodes" || r.d.selected !== "true" || r.d.tabindex !== "0") throw new Error(`reached ${JSON.stringify(r.d)}, want the nodes tab selected`);
    await h.waitDom("nodes tabpanel", () => document.getElementById("explore-detail-panel")?.getAttribute("aria-labelledby") === "explore-detail-tab-nodes");
    await k.press("ArrowRight");
    await k.press("Enter");
    await h.waitDom("route tab repaired", () => new URLSearchParams(location.hash.split("?")[1] ?? "").get("tab") === "search");
    await k.expectFocus({ id: "explore-detail-tab-search", selected: "true", tabindex: "0" }, "Enter activates");
    return `${link}: one tab stop (${stops[0]}), reached by Tab x${r.presses} with nodes selected; ArrowRight + Enter -> tab=search`;
  });
}
