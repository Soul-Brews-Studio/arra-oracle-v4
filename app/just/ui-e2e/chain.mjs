// The knowledge half of the #33 AC1 chain, driven through the BUILT UI:
// seed -> create -> revise -> cite -> correct -> retire a citer -> explicitly
// supersede. Every write here is a click in the Knowledge or Explore view;
// the only direct API use is READING rows (listAcceptedHistory) to pin the
// revision-1 snapshot the history step later compares byte-for-byte.
//
// `ctx` carries ids and snapshots forward; a later step that needs something
// an earlier failed step never produced throws a plain "missing" error, so a
// failure cascades as visible STEP_FAILs instead of being skipped over.
import { pageProbes as P } from "./probes.mjs";

export const TEXT = {
  a1: { title: "Dev server port — พอร์ตเซิร์ฟเวอร์", body: "The dev server listens on 47777.\nเซิร์ฟเวอร์ dev ฟังที่พอร์ต 47777" },
  a2: { title: "Dev server port — พอร์ตเซิร์ฟเวอร์ (rev 2)", body: "The dev server listens on 47777; the test server on 47778.\nเซิร์ฟเวอร์ทดสอบฟังที่พอร์ต 47778", reason: "add the test server port" },
  d: { title: "Port list draft (retired later)", body: "Scratch list of ports, cites A #2; retired before the supersede." },
  b: { title: "Port conventions: อย่าหลงลืม", body: "อย่าหลงลืมจองพอร์ตก่อนรันเทสต์ -- never forget to reserve the port before a test run." },
  c: { title: "Test server port is 47779", body: "Correction: the test server moved to 47779; revision #2 said 47778.", reason: "port moved" },
  url: "https://example.invalid/runbooks/ports",
};

export const DIFF_1_VS_2 = [
  { root: "diff", select: "select:nth-of-type(1)", optionText: "#1 — " },
  { root: "diff", select: "select:nth-of-type(2)", optionText: "#2 — " },
];

const need = (ctx, key) => {
  if (ctx[key] === undefined || ctx[key] === null) throw new Error(`missing ${key} (an earlier step failed)`);
  return ctx[key];
};

async function publishNew(h, { title, body, links = [] }) {
  await h.act([{ click: "new" }]);
  await h.waitDom("draft form", P.knowledge).then((k) => { if (!k.draft) throw new Error("no draft after new"); });
  const ops = [
    { root: "publish", fill: 'input[placeholder="title…"]', value: title },
    { root: "publish", fill: 'textarea[placeholder="body…"]', value: body },
  ];
  links.forEach((l, i) => {
    const n = i + 1;
    ops.push({ root: "publish", click: "+ add evidence link" });
    ops.push({ root: "publish", select: `select[aria-label="link ${n} relation"]`, value: l.relation });
    if (l.kind !== "node_revision") ops.push({ root: "publish", select: `select[aria-label="link ${n} target kind"]`, value: l.kind });
    if (l.pick) ops.push({ root: "publish", select: `select[aria-label="link ${n} pick a loaded revision"]`, optionText: l.pick });
    if (l.url) ops.push({ root: "publish", fill: `input[aria-label="link ${n} url"]`, value: l.url });
    if (l.note) ops.push({ root: "publish", fill: `input[aria-label="link ${n} note"]`, value: l.note });
  });
  ops.push({ root: "publish", click: "create node" });
  await h.act(ops);
  const k = await h.waitDom(`published "${title}"`, (t) => {
    const node = new URLSearchParams(location.hash.split("?")[1] ?? "").get("node");
    const h2 = document.querySelector("main h2")?.textContent ?? null;
    return node && h2 === t ? { node } : null;
  }, title);
  return k.node;
}

const history = (h, node) => h.page.evaluate(P.api, { method: "listAcceptedHistory", body: { workspace_name: "default", node_id: node } });

export async function runChain(h, ctx) {
  await h.step("ui-seed-vocab", async () => {
    await h.go("#/knowledge");
    await h.waitDom("knowledge view", () => document.body.textContent.includes("seed reserved vocabularies") || document.body.textContent.includes("memory_horizon"));
    if (await h.page.evaluate(() => document.body.textContent.includes("seed reserved vocabularies"))) {
      await h.act([{ click: "seed reserved vocabularies" }]);
    }
    await h.waitDom("vocab seeded", () => !document.body.textContent.includes("Reserved vocabularies not seeded") && document.body.textContent.includes("memory_horizon"));
    ctx.taxonomy = await h.page.evaluate(P.taxonomy);
    if (!ctx.taxonomy?.type?.terms?.note) throw new Error(`no minted type ids in localStorage: ${JSON.stringify(ctx.taxonomy)}`);
    return "type + memory_horizon seeded from the UI";
  });

  await h.step("create", async () => {
    ctx.A = await publishNew(h, TEXT.a1);
    const k = await h.waitDom("history #1", P.knowledge);
    if (k.history.join(",") !== "#1") throw new Error(`history ${k.history}`);
    await h.shot("01-created");
    return `node A=${ctx.A} rev #1`;
  });

  await h.step("revise", async () => {
    const A = need(ctx, "A");
    await h.act([
      { root: "publish", fill: 'input[placeholder="title…"]', value: TEXT.a2.title },
      { root: "publish", fill: 'textarea[placeholder="body…"]', value: TEXT.a2.body },
      { root: "publish", fill: 'input[placeholder="change reason (optional)…"]', value: TEXT.a2.reason },
      { root: "publish", click: "publish revision" },
    ]);
    const k = await h.waitDom("head #2", (t) => {
      const h2 = document.querySelector("main h2")?.textContent;
      const hist = [...document.querySelectorAll("main button span.font-mono")].map((s) => s.textContent.trim()).filter((x) => /^#\d+$/.test(x));
      return h2 === t && hist.length === 2 ? { hist } : null;
    }, TEXT.a2.title);
    const rows = await history(h, A);
    const list = rows.json?.rows ?? rows.json?.revisions ?? rows.json;
    if (!Array.isArray(list) || list.length !== 2) throw new Error(`listAcceptedHistory: ${JSON.stringify(rows).slice(0, 300)}`);
    const r1 = list.find((r) => String(r.revision_no) === "1");
    const r2 = list.find((r) => String(r.revision_no) === "2");
    ctx.A1 = r1.id;
    ctx.A2 = r2.id;
    if (r1.title !== TEXT.a1.title || r1.body !== TEXT.a1.body) throw new Error("rev 1 as stored differs from what was typed");
    ctx.rev1Row = { title: r1.title, body: r1.body, term_snapshot_json: r1.term_snapshot_json, link_snapshot_json: r1.link_snapshot_json, content_digest: r1.content_digest };
    // Pick the pair explicitly, as a reader would: after an in-place
    // revise the picker keeps its old (#1 vs #1) choice -- see UI-E2E.md,
    // "Defects found".
    await h.act(DIFF_1_VS_2);
    ctx.rev1Dom = await h.waitDom("diff from rev 1", P.diffFrom);
    if (ctx.rev1Dom.title !== TEXT.a1.title) throw new Error(`diff 'from' title ${JSON.stringify(ctx.rev1Dom.title)}`);
    await h.shot("02-revised-diff", "diff");
    return `A #2=${ctx.A2.slice(0, 8)}… history ${k.hist.join(",")}; rev1 DOM snapshot pinned`;
  });

  await h.step("cite", async () => {
    need(ctx, "A2");
    const a1 = `#1 — ${TEXT.a1.title}`;
    const a2 = `#2 — ${TEXT.a2.title}`;
    ctx.D = await publishNew(h, { ...TEXT.d, links: [{ relation: "supports", kind: "node_revision", pick: a2 }] });
    ctx.B = await publishNew(h, {
      ...TEXT.b,
      links: [
        { relation: "supports", kind: "node_revision", pick: a2, note: "cites the current head" },
        { relation: "related_to", kind: "node_revision", pick: a1, note: "cites an older revision on purpose" },
        { relation: "derived_from", kind: "url", url: TEXT.url },
      ],
    });
    // DIRECT evidence on the citing node B.
    await h.go(`#/explore?node=${ctx.B}&tab=evidence`);
    const ev = await h.waitDom("B direct evidence settled", (b) => {
      const sec = [...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === "Direct evidence")?.parentElement;
      const t = sec?.textContent ?? "";
      return t.includes("links (3)") && !t.includes("checking target") && !t.includes("loading") && new URLSearchParams(location.hash.split("?")[1] ?? "").get("node") === b;
    }, ctx.B).then(() => h.page.evaluate(P.evidence));
    const byRev = (id) => ev.direct.find((r) => r.text.includes(id));
    const l1 = byRev(ctx.A2), l2 = byRev(ctx.A1), l3 = ev.direct.find((r) => r.text.includes(TEXT.url));
    const want = [
      [l1, ["locator only", "current head"]],
      [l2, ["locator only", "stale: not head"]],
      [l3, ["locator only"]],
    ];
    for (const [row, badges] of want) {
      if (!row) throw new Error(`direct evidence row missing: ${JSON.stringify(ev.direct).slice(0, 400)}`);
      if (JSON.stringify(row.badges) !== JSON.stringify(badges)) throw new Error(`badges ${JSON.stringify(row.badges)} != ${JSON.stringify(badges)}`);
    }
    await h.shot("03-direct-evidence", "Direct evidence");
    // REVERSE evidence on the cited node A (head #2): B and D both cite it.
    await h.go(`#/explore?node=${ctx.A}&tab=evidence`);
    const rv = await h.waitDom("A reverse evidence settled", (ids) => {
      const sec = [...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === "Reverse evidence")?.parentElement;
      const who = [...(sec?.querySelectorAll("li span[title]") ?? [])].map((s) => s.getAttribute("title"));
      return ids.every((id) => who.includes(id)) && !sec.textContent.includes("checking citing");
    }, [ctx.B, ctx.D]).then(() => h.page.evaluate(P.evidence));
    for (const id of [ctx.B, ctx.D]) {
      const row = rv.reverse.find((r) => r.who === id);
      if (JSON.stringify(row.badges) !== JSON.stringify(["locator only", "citing node current"])) throw new Error(`reverse ${id}: ${row.badges}`);
    }
    await h.shot("04-reverse-evidence", "Reverse evidence");
    return `B=${ctx.B} cites A#2 (current head), A#1 (stale: not head), url (locator only); A shows REVERSE rows for B and D`;
  });

  await h.step("correct", async () => {
    const A = need(ctx, "A");
    await h.go(`#/knowledge?node=${A}`);
    await h.waitDom("A loaded", (t) => document.querySelector("main h2")?.textContent === t, TEXT.a2.title);
    await h.act([
      { root: "correct", select: 'select[aria-label="revision to correct"]', optionText: `#2 — ${TEXT.a2.title}` },
      { root: "correct", fill: 'input[aria-label="correction title"]', value: TEXT.c.title },
      { root: "correct", fill: 'textarea[aria-label="correction body"]', value: TEXT.c.body },
      { root: "correct", fill: 'input[aria-label="correction reason"]', value: TEXT.c.reason },
      { root: "correct", click: "record correction" },
    ]);
    const k = await h.waitDom("correction opened", (t) => {
      const node = new URLSearchParams(location.hash.split("?")[1] ?? "").get("node");
      return document.querySelector("main h2")?.textContent === t ? { node } : null;
    }, TEXT.c.title);
    ctx.C = k.node;
    await h.go(`#/explore?node=${ctx.C}&tab=evidence`);
    const ev = await h.waitDom("C corrects link", (a2) => {
      const sec = [...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === "Direct evidence")?.parentElement;
      return sec && sec.textContent.includes(a2) && sec.textContent.includes("corrects") && !sec.textContent.includes("checking target");
    }, ctx.A2).then(() => h.page.evaluate(P.evidence));
    ctx.C1 = ev.headRevisionId;
    if (!ctx.C1) throw new Error("C head revision id not shown");
    const row = ev.direct.find((r) => r.text.includes(ctx.A2));
    if (!row.text.includes("corrects") || !row.badges.includes("current head")) throw new Error(`corrects row ${JSON.stringify(row)}`);
    await h.shot("05-correction-evidence", "Direct evidence");
    return `C=${ctx.C} (type correction) corrects A#2; C rev ${ctx.C1.slice(0, 8)}…`;
  });

  await h.step("retire-citing-node", async () => {
    const D = need(ctx, "D");
    await h.go(`#/explore?node=${D}&tab=evidence`);
    await h.waitDom("D evidence tab", (d) => document.body.textContent.includes("Lifecycle actions") && new URLSearchParams(location.hash.split("?")[1] ?? "").get("node") === d && [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Retire…" && !b.disabled), D);
    await h.act([
      { root: "lifecycle", click: "Retire…" },
      { root: "lifecycle", fill: 'textarea[placeholder="reason (required)…"]', value: "scratch list, replaced by B" },
      { root: "lifecycle", click: "Confirm retire" },
    ]);
    const out = await h.waitDom("retire accepted", () => {
      const t = [...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === "Lifecycle actions")?.parentElement?.textContent ?? "";
      return /accepted — lifecycle history refreshed/.test(t) ? t : null;
    });
    return `D retired (${out.match(/accepted[^b]*/)?.[0] ?? "accepted"})`;
  });

  await h.step("supersede", async () => {
    const A = need(ctx, "A"), C = need(ctx, "C"), C1 = need(ctx, "C1");
    await h.go(`#/explore?node=${A}&tab=evidence`);
    await h.waitDom("A evidence tab", (a) => new URLSearchParams(location.hash.split("?")[1] ?? "").get("node") === a && [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Supersede…" && !b.disabled), A);
    await h.act([
      { root: "lifecycle", click: "Supersede…" },
      { root: "lifecycle", fill: 'input[placeholder="successor node_id…"]', value: C },
      { root: "lifecycle", fill: `input[placeholder="successor's current revision_id…"]`, value: C1 },
      { root: "lifecycle", fill: 'textarea[placeholder="reason (required)…"]', value: "the correction replaces this node" },
      { root: "lifecycle", click: "Confirm supersede" },
    ]);
    await h.waitDom("supersede accepted", () => /accepted — lifecycle history refreshed/.test([...document.querySelectorAll("h3")].find((x) => x.textContent.trim() === "Lifecycle actions")?.parentElement?.textContent ?? ""));
    await h.go(`#/knowledge?node=${A}`);
    const g = await h.waitDom("superseded banner", () => {
      const b = document.querySelector('[role="status"]');
      return b && /superseded/i.test(b.textContent) && document.querySelector("main fieldset") ? true : null;
    }).then(() => h.page.evaluate(P.gate));
    const bad = [];
    if (!g.successorHref?.includes(C)) bad.push(`successor link ${g.successorHref}`);
    if (g.fieldsetDisabled !== true) bad.push("fieldset not disabled");
    if (g.publishDisabled !== true) bad.push("publish revision enabled");
    if (g.correctDisabled !== true) bad.push("record correction enabled");
    if (g.titleDisabled !== true) bad.push("title input enabled");
    if (bad.length) throw new Error(`${bad.join("; ")} :: ${JSON.stringify(g)}`);
    await h.shot("06-superseded-writes-disabled");
    return { banner: g.banner.slice(0, 60), fieldsetDisabled: true, publishDisabled: true, correctDisabled: true };
  });
}
