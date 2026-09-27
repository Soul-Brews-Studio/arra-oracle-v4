// The #33 AC2 KEYBOARD segment of app/just/ui-e2e.sh: the peer -> session ->
// message -> Knowledge -> publish -> revise -> cite -> correct -> supersede ->
// history chain, driven with the keyboard ONLY (keyNav.mjs: Tab, Shift+Tab,
// arrows, Home/End, Enter, Space, typing). No DOM .click, no value setters,
// no hash navigation: the page is only READ, to assert DOM state and
// `document.activeElement` after each step. The one exception is reading a
// revision id through the API (probes.api), which types nothing and clicks
// nothing -- the id is then TYPED into the supersede form.
//
// Activation model under test (TabStrip.tsx): arrows move focus between
// tabs WITHOUT activating; Enter/Space activate. List rows are buttons in
// the Tab order; arrows also move between them.
//
// Last step: the 812x375 landscape measurement (a device-metrics override,
// scaled by ego's per-origin zoom so innerWidth x innerHeight really is
// 812 x 375), then a message typed and sent there by keyboard.
import { keyNav } from "./keyNav.mjs";
import { need } from "./need.mjs";
import { nid } from "./nid.mjs";
import { probes as P } from "./probes.mjs";

const route = () => {
  const [path, q] = location.hash.slice(1).split("?");
  return { path, ...Object.fromEntries(new URLSearchParams(q ?? "")) };
};

export async function keys(h, cfg) {
  const k = keyNav(h);
  const ctx = {};
  const tag = nid().slice(0, 6);
  const T = {
    msg: `keyboard hello ${tag}`,
    a: `Keyboard node ${tag}`,
    b: `Keyboard citer ${tag}`,
    c: `Keyboard correction ${tag}`,
    narrow: `narrow hello ${tag}`,
  };
  const at = (m) => h.waitDom(`route ${JSON.stringify(m)}`, (want) => {
    const [path, q] = location.hash.slice(1).split("?");
    const r = { path, ...Object.fromEntries(new URLSearchParams(q ?? "")) };
    return Object.entries(want).every(([key, v]) => r[key] === v) ? r : null;
  }, m);
  const h2Is = (t) => h.waitDom(`main h2 "${t}"`, (x) => document.querySelector("main h2")?.textContent === x, t);
  const head = async (node) => {
    const r = await h.page.evaluate(P.api, { method: "getAcceptedHead", body: { workspace_name: "default", node_id: node } });
    const rev = r.json?.revision ?? r.json?.row ?? r.json;
    if (!rev?.id) throw new Error(`getAcceptedHead ${node}: ${JSON.stringify(r).slice(0, 300)}`);
    return rev;
  };

  await h.step("keys-view-tabs", async () => {
    await h.waitDom("overview open", () => location.hash.startsWith("#/overview") && document.querySelector('[role="tablist"][aria-label="Views"]') !== null);
    const first = await k.tabTo({ id: "app-view-tab-overview" });
    if (first.d.selected !== "true" || first.d.tabindex !== "0") throw new Error(`selected tab not the tab stop: ${JSON.stringify(first.d)}`);
    await k.press("ArrowRight");
    await k.expectFocus({ id: "app-view-tab-explore", selected: "false" }, "ArrowRight moves focus only");
    if ((await h.page.evaluate(route)).path !== "/overview") throw new Error("ArrowRight activated a tab (manual activation expected)");
    await k.press("End");
    await k.expectFocus({ id: "app-view-tab-knowledge" }, "End");
    await k.press("Home");
    await k.expectFocus({ id: "app-view-tab-overview" }, "Home");
    await k.press("ArrowLeft");
    await k.expectFocus({ id: "app-view-tab-knowledge" }, "ArrowLeft wraps");
    await k.press("ArrowRight");
    await k.press("ArrowRight");
    await k.press("Enter");
    await at({ path: "/explore" });
    await k.expectFocus({ id: "app-view-tab-explore", selected: "true", tabindex: "0" }, "Enter activates, focus stays");
    return `Tab x${first.presses} to the view tablist; ArrowRight/End/Home/ArrowLeft move focus only; Enter opened explore`;
  });

  await h.step("keys-open-peer", async () => {
    const r = await k.tabTo({ row: cfg.peer });
    await k.press("ArrowDown");
    const next = await k.active();
    if (!next.row || next.row === cfg.peer) throw new Error(`ArrowDown did not move to the next row: ${JSON.stringify(next)}`);
    await k.press("ArrowUp");
    await k.expectFocus({ row: cfg.peer }, "ArrowUp back");
    await k.press("Enter");
    await at({ path: "/explore", peer: cfg.peer });
    await h.waitDom("aria-current on peer", (p) => document.querySelector(`button[data-row="${p}"]`)?.getAttribute("aria-current") === "true", cfg.peer);
    await k.expectFocus({ row: cfg.peer, current: "true" }, "focus stays on the opened row");
    return `Tab x${r.presses} to row ${cfg.peer}; ArrowDown -> ${next.row}, ArrowUp back; Enter opened it (aria-current=true)`;
  });

  await h.step("keys-open-session", async () => {
    const r = await k.tabTo({ row: cfg.session });
    await k.press("Space");
    await at({ peer: cfg.peer, session: cfg.session });
    await k.expectFocus({ row: cfg.session, current: "true" }, "focus stays on the opened row");
    return `Tab x${r.presses} to row ${cfg.session}; Space opened it`;
  });

  await h.step("keys-detail-tabs", async () => {
    const r = await k.tabTo({ role: "tab", selected: "true", textHas: "nodes" });
    await k.press("End");
    await k.expectFocus({ id: "explore-detail-tab-config" }, "End");
    await k.press("Home");
    await k.expectFocus({ id: "explore-detail-tab-nodes" }, "Home");
    for (let i = 0; i < 3; i++) await k.press("ArrowRight");
    await k.expectFocus({ id: "explore-detail-tab-messages", selected: "false" }, "ArrowRight x3");
    await k.press("Enter");
    await at({ tab: "messages" });
    await h.waitDom("messages panel", () => document.getElementById("explore-detail-panel")?.getAttribute("aria-labelledby") === "explore-detail-tab-messages");
    await k.expectFocus({ id: "explore-detail-tab-messages", selected: "true", tabindex: "0" }, "Enter activates");
    return `Tab x${r.presses} to the detail tablist; End/Home/ArrowRight x3 then Enter -> messages tabpanel`;
  });

  await h.step("keys-send-message", async () => {
    const r = await k.tabTo({ label: "Message content" });
    await k.type(T.msg);
    await k.press("Control+Enter");
    await h.waitDom("message in transcript", (t) => document.getElementById("explore-detail-panel")?.textContent.includes(t) && !document.querySelector("textarea[aria-label='Message content']")?.value, T.msg);
    await k.expectFocus({ label: "Message content" }, "focus stays in the composer");
    return `Tab x${r.presses} to the composer; typed + Control+Enter; "${T.msg}" is in the transcript`;
  });

  await h.step("keys-open-knowledge", async () => {
    const r = await k.tabTo({ id: "app-view-tab-explore" }, { back: true, max: 80 });
    await k.press("End");
    await k.press("Enter");
    await at({ path: "/knowledge" });
    await k.expectFocus({ id: "app-view-tab-knowledge", selected: "true" }, "Enter activates");
    // A keys-only run starts on a fresh dataset: seed the reserved
    // vocabularies (publish needs them) with the keyboard too.
    let seeded = "already seeded";
    await h.waitDom("knowledge view", () => document.body.textContent.includes("seed reserved vocabularies") || document.body.textContent.includes("memory_horizon"));
    if (await h.page.evaluate(() => document.body.textContent.includes("seed reserved vocabularies"))) {
      await k.tabTo({ tag: "BUTTON", text: "seed reserved vocabularies" });
      await k.press("Enter");
      await h.waitDom("vocab seeded", () => !document.body.textContent.includes("Reserved vocabularies not seeded") && document.body.textContent.includes("memory_horizon"));
      seeded = "seeded by Tab + Enter";
      await k.tabTo({ id: "app-view-tab-knowledge" }, { back: true, max: 80 });
    }
    return `Shift+Tab x${r.presses} back to the view tablist; End + Enter -> knowledge; vocab ${seeded}`;
  });

  await h.step("keys-publish-and-revise", async () => {
    await k.tabTo({ tag: "BUTTON", text: "new" });
    await k.press("Enter");
    await k.tabTo({ label: "Title" });
    await k.type(T.a);
    await k.tabTo({ label: "Body" });
    await k.type("Body typed on the keyboard.");
    await k.tabTo({ tag: "BUTTON", text: "create node" });
    await k.press("Enter");
    await h2Is(T.a);
    ctx.A = (await h.waitDom("A in route", () => new URLSearchParams(location.hash.split("?")[1] ?? "").get("node"))) ;
    const afterCreate = await k.active();
    if (afterCreate.tag === "BODY") throw new Error("focus lost to <body> after create");
    // The form clears after an accepted publish: a revision is typed whole.
    await k.tabTo({ label: "Title" }, { back: true });
    await k.type(`${T.a} v2`);
    await k.tabTo({ label: "Body" });
    await k.type("Body typed on the keyboard, revised.");
    await k.tabTo({ label: "Change reason (optional)" });
    await k.type("revised by keyboard");
    await k.tabTo({ tag: "BUTTON", text: "publish revision" });
    await k.press("Enter");
    await h2Is(`${T.a} v2`);
    await h.waitDom("history #1 #2", () => [...document.querySelectorAll("main button span.font-mono")].map((s) => s.textContent.trim()).filter((x) => /^#\d+$/.test(x)).length === 2);
    const afterRevise = await h.waitDom("focus not lost after publish revision", () => document.activeElement && document.activeElement !== document.body ? document.activeElement.tagName + ":" + document.activeElement.textContent.slice(0, 30) : null, undefined, 5000).then((x) => ({ tag: x.split(":")[0], text: x.slice(x.indexOf(":") + 1) }));
    ctx.A2 = (await head(ctx.A)).id;
    return `A=${ctx.A} created then revised to #2; focus after create: ${afterCreate.tag}:${afterCreate.text.slice(0, 20)}, after revise: ${afterRevise.tag}:${afterRevise.text.slice(0, 20)}`;
  });

  await h.step("keys-cite", async () => {
    const A2 = need(ctx, "A2");
    await k.tabTo({ tag: "BUTTON", text: "new" }, { back: true });
    await k.press("Enter");
    await k.tabTo({ label: "Title" });
    await k.type(T.b);
    await k.tabTo({ label: "Body" });
    await k.type("Cites the keyboard node.");
    await k.tabTo({ tag: "BUTTON", text: "+ add evidence link" });
    await k.press("Enter");
    await k.tabTo({ label: "link 1 pick a loaded revision" });
    await k.type("#2");
    const pick = await k.expectFocus({ label: "link 1 pick a loaded revision" }, "pick select");
    if (!pick.optionText.startsWith("#2")) throw new Error(`type-ahead did not pick #2: ${JSON.stringify(pick)}`);
    await k.tabTo({ tag: "BUTTON", text: "create node" });
    await k.press("Enter");
    await h2Is(T.b);
    ctx.B = await h.waitDom("B in route", (a) => { const n = new URLSearchParams(location.hash.split("?")[1] ?? "").get("node"); return n && n !== a ? n : null; }, ctx.A);
    const rev = await head(ctx.B);
    if (!String(rev.link_snapshot_json).includes(A2)) throw new Error(`B's link snapshot lacks A#2: ${rev.link_snapshot_json}`);
    return `B=${ctx.B} cites A#2 (${A2.slice(0, 8)}…), picked by type-ahead "${pick.optionText.slice(0, 30)}"`;
  });

  await h.step("keys-correct", async () => {
    need(ctx, "A2");
    const r = await k.tabTo({ tag: "BUTTON", textStarts: `${T.a} v2` }, { back: true });
    await k.press("Enter");
    await h2Is(`${T.a} v2`);
    await h.waitDom("focus on A's heading", (t) => document.activeElement?.tagName === "H2" && document.activeElement.textContent === t, `${T.a} v2`);
    await k.tabTo({ label: "revision to correct" });
    await k.type("#2");
    const sel = await k.active();
    if (!sel.optionText?.startsWith("#2")) throw new Error(`revision to correct: ${JSON.stringify(sel)}`);
    await k.tabTo({ label: "correction title" });
    await k.type(T.c);
    await k.tabTo({ label: "correction body" });
    await k.type("The keyboard node was wrong about one thing.");
    await k.tabTo({ label: "correction reason" });
    await k.type("keyboard correction");
    await k.tabTo({ tag: "BUTTON", text: "record correction" });
    await k.press("Enter");
    await h2Is(T.c);
    ctx.C = await h.waitDom("C in route", (a) => { const n = new URLSearchParams(location.hash.split("?")[1] ?? "").get("node"); return n && n !== a ? n : null; }, ctx.A);
    ctx.C1 = (await head(ctx.C)).id;
    const f = await k.active();
    if (f.tag === "BODY") throw new Error("focus lost to <body> after the correction opened");
    return `Shift+Tab x${r.presses} to A in the node rail, Enter -> focus on A's <h2>; C=${ctx.C} corrects A#2; focus now ${f.tag}:${f.text.slice(0, 24)}`;
  });

  await h.step("keys-supersede", async () => {
    const A = need(ctx, "A"), C = need(ctx, "C"), C1 = need(ctx, "C1");
    await k.tabTo({ tag: "BUTTON", textStarts: `${T.a} v2` }, { back: true });
    await k.press("Enter");
    await h2Is(`${T.a} v2`);
    await k.tabTo({ id: "app-view-tab-knowledge" }, { back: true });
    for (let i = 0; i < 3; i++) await k.press("ArrowLeft");
    await k.expectFocus({ id: "app-view-tab-explore" }, "ArrowLeft x3");
    await k.press("Enter");
    await at({ path: "/explore", node: A });
    await k.tabTo({ role: "tab", selected: "true", idStarts: "explore-detail-tab-" });
    await k.press("Home");
    for (let i = 0; i < 4; i++) await k.press("ArrowRight");
    await k.expectFocus({ id: "explore-detail-tab-evidence" }, "Home + ArrowRight x4");
    await k.press("Enter");
    await at({ tab: "evidence", node: A });
    await k.tabTo({ tag: "BUTTON", text: "Supersede…" }, { max: 80 });
    await k.press("Enter");
    await k.tabTo({ placeholder: "successor node_id…" });
    await k.type(C);
    await k.tabTo({ placeholder: "successor's current revision_id…" });
    await k.type(C1);
    await k.tabTo({ placeholder: "reason (required)…" });
    await k.type("the keyboard correction replaces this node");
    await k.tabTo({ tag: "BUTTON", text: "Confirm supersede" });
    await k.press("Enter");
    await h.waitDom("supersede accepted", () => /accepted — lifecycle history refreshed/.test([...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === "Lifecycle actions")?.parentElement?.textContent ?? ""));
    return `A superseded by C (${C1.slice(0, 8)}…) from Explore > evidence, ids typed`;
  });

  await h.step("keys-read-history", async () => {
    const A = need(ctx, "A");
    await k.tabTo({ role: "tab", selected: "true", idStarts: "app-view-tab-" }, { back: true, max: 120 });
    await k.press("End");
    await k.press("Enter");
    await at({ path: "/knowledge", node: A });
    await h.waitDom("superseded banner", () => /superseded/i.test(document.querySelector('[role="status"]')?.textContent ?? ""));
    await h2Is(`${T.a} v2`);
    // Fix round: activating a view tab leaves focus ON the tab (WAI-ARIA
    // tabs), even though the view opened a node -- NodeHead no longer takes
    // focus off a role=tab. Waited past the node load, so a late grab shows.
    await h.sleep(400);
    await k.expectFocus({ id: "app-view-tab-knowledge", selected: "true", tabindex: "0" }, "focus stays on the activated tab");
    const f = "focus stayed on the knowledge tab";
    const r = await k.tabTo({ tag: "BUTTON", textStarts: "#1" });
    await k.press("Enter");
    const from = await h.waitDom("diff from #1", P.diffFrom);
    if (from.title !== T.a) throw new Error(`diff 'from' title ${JSON.stringify(from.title)} != ${T.a}`);
    await k.expectFocus({ tag: "BUTTON", textStarts: "#1" }, "focus stays on the history entry");
    return `knowledge opened, ${f}; Tab x${r.presses} to history #1, Enter -> diff from rev 1 "${from.title}"`;
  });

  await h.step("keys-narrow-812x375", async () => {
    const dpr = await h.page.evaluate(() => window.devicePixelRatio);
    const setMetrics = async (s) => {
      await h.page.cdp("Emulation.setDeviceMetricsOverride", { width: Math.round(812 * s), height: Math.round(375 * s), deviceScaleFactor: 1, mobile: false });
      await h.sleep(400);
      return h.page.evaluate(() => [window.innerWidth, window.innerHeight]);
    };
    let [w, hh] = await setMetrics(dpr);
    if (Math.abs(w - 812) > 2) [w, hh] = await setMetrics(dpr * (812 / w));
    if (Math.abs(w - 812) > 2 || Math.abs(hh - 375) > 3) throw new Error(`could not reach 812x375 CSS px (got ${w}x${hh}, dpr ${dpr})`);
    // Back to Explore > messages by keyboard.
    await k.tabTo({ role: "tab", selected: "true", idStarts: "app-view-tab-" }, { back: true, max: 80 });
    await k.press("Home");
    await k.press("ArrowRight");
    await k.press("Enter");
    await at({ path: "/explore" });
    await k.tabTo({ role: "tab", selected: "true", idStarts: "explore-detail-tab-" }, { max: 80 });
    await k.press("Home");
    for (let i = 0; i < 3; i++) await k.press("ArrowRight");
    await k.press("Enter");
    await at({ tab: "messages" });
    await k.tabTo({ label: "Message content" });
    await k.type(T.narrow);
    await k.press("Control+Enter");
    await h.waitDom("narrow message sent", (t) => document.getElementById("explore-detail-panel")?.textContent.includes(t), T.narrow);
    const m = await h.page.evaluate(() => {
      const sec = document.querySelector('section[aria-label="Explore detail"]');
      sec.scrollIntoView({ block: "start" });
      const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
      const tabs = sec.querySelector('[role="tablist"]');
      const ta = sec.querySelector("textarea[aria-label='Message content']");
      const send = [...sec.querySelectorAll("button")].find((b) => /^(send|sending…)$/.test(b.textContent.trim()));
      return { vw: innerWidth, vh: innerHeight, docScroll: document.scrollingElement.scrollHeight, overflowX: document.scrollingElement.scrollWidth > innerWidth, pane: r(sec), tablist: r(tabs), transcript: { h: Math.round(ta.closest("div").getBoundingClientRect().top - tabs.getBoundingClientRect().bottom) }, textarea: r(ta), send: r(send) };
    });
    const bad = [];
    if (m.overflowX) bad.push("horizontal overflow");
    if (m.tablist.top < 0) bad.push("tab bar above the viewport");
    if (m.send.bottom > m.vh) bad.push(`send button below the fold (${m.send.bottom} > ${m.vh})`);
    if (m.transcript.h < 120) bad.push(`transcript only ${m.transcript.h}px`);
    // Fix round: the Messages view (#/messages) at the same 812x375, reached
    // and used by keyboard -- the round-1 report left it unmeasured.
    await k.tabTo({ role: "tab", selected: "true", idStarts: "app-view-tab-" }, { back: true, max: 80 });
    await k.press("Home");
    await k.press("ArrowRight");
    await k.press("ArrowRight");
    await k.press("Enter");
    await at({ path: "/messages" });
    await k.tabTo({ label: "Message content", inMain: true }, { max: 80 });
    await k.type(`${T.narrow} (messages view)`);
    await k.press("Control+Enter");
    await h.waitDom("messages-view message sent", (t) => document.querySelector("main")?.textContent.includes(t), `${T.narrow} (messages view)`);
    const mv = await h.page.evaluate(() => {
      const main = document.querySelector("main");
      main.scrollIntoView({ block: "start" });
      const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
      const ta = main.querySelector("textarea[aria-label='Message content']");
      const send = [...main.querySelectorAll("button")].find((b) => /^(send|sending…)$/.test(b.textContent.trim()));
      return { main: r(main), overflowX: document.scrollingElement.scrollWidth > innerWidth, textarea: r(ta), send: r(send), transcript: { h: Math.round(ta.closest("div").getBoundingClientRect().top - main.getBoundingClientRect().top) } };
    });
    if (mv.overflowX) bad.push("messages view: horizontal overflow");
    if (mv.send.bottom > m.vh) bad.push(`messages view: send below the fold (${mv.send.bottom} > ${m.vh})`);
    if (mv.transcript.h < 120) bad.push(`messages view: transcript only ${mv.transcript.h}px`);
    await h.ensureViewport();
    if (bad.length) throw new Error(`${bad.join("; ")} :: ${JSON.stringify({ explore: m, messages: mv })}`);
    return { explore: m, messages: mv };
  });
}
