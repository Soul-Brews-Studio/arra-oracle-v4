// Page-side probes for app/just/ui-e2e.sh: every function here runs INSIDE
// the page via `page.evaluate`, so each one is self-contained (no closures
// over this module) and returns plain JSON. `pageProbes` is the one export:
// the harness steps pick probes off it by name.
//
// They read what a person would read -- headings, badges, button states --
// not React internals, so a UI that stops rendering a label fails the step
// even if the data underneath is still right.

export const pageProbes = {
  // The node the Knowledge view has open: route id, head title, history list.
  knowledge: () => {
    const node = new URLSearchParams(location.hash.split("?")[1] ?? "").get("node");
    const title = document.querySelector("main h2")?.textContent ?? null;
    const history = [...document.querySelectorAll("main button span.font-mono")]
      .map((s) => s.textContent.trim())
      .filter((t) => /^#\d+$/.test(t));
    const draft = document.body.textContent.includes("draft — not published yet");
    const errors = [...document.querySelectorAll("p")].map((p) => p.textContent).filter((t) => /refused|invalid_|error/i.test(t)).slice(0, 3);
    return { node, title, history, draft, errors };
  },

  // The revision diff's "from" side, exactly as rendered: title, left body
  // column, and the from-terms list (the label snapshot a reader sees).
  diffFrom: () => {
    const fromHead = [...document.querySelectorAll("p")].find((p) => /^from · rev /.test(p.textContent.trim()));
    if (!fromHead) return { ok: false, why: "no diff on screen" };
    const title = fromHead.nextElementSibling?.getAttribute("title") ?? null;
    const tables = [...fromHead.closest("div.rounded").querySelectorAll("table")];
    const bodyTable = tables[tables.length - 1];
    const left = [...bodyTable.querySelectorAll("tr")].map((tr) => tr.children[0]?.textContent ?? "").filter((t) => t !== "—");
    const termsHead = [...document.querySelectorAll("p")].find((p) => /^terms \(/.test(p.textContent.trim()));
    const fromTerms = termsHead ? termsHead.parentElement.textContent : null;
    return { rev: fromHead.textContent.trim(), title, bodyLines: left, fromTerms };
  },

  // Direct + reverse evidence rows on the Explore > Evidence tab, with the
  // badge texts each row shows. `pending` counts "checking…" badges, so a
  // caller can wait for every live lookup to land before judging labels.
  evidence: () => {
    const section = (t) => [...document.querySelectorAll("h3")].find((h) => h.textContent.trim() === t)?.parentElement ?? null;
    const rows = (sec) =>
      sec === null
        ? null
        : [...sec.querySelectorAll("li")]
            .filter((li) => li.lastElementChild?.firstElementChild?.querySelector("span[title]"))
            .map((li) => ({
              text: li.textContent,
              who: li.querySelector("span[title]")?.getAttribute("title") ?? null,
              badges: [...li.lastElementChild.firstElementChild.children].map((s) => s.textContent.trim()),
            }));
    const direct = section("Direct evidence");
    const revSpan = direct ? [...direct.querySelectorAll("span[title]")].find((s) => s.textContent.startsWith("rev ")) : null;
    const d = rows(direct);
    const r = rows(section("Reverse evidence"));
    const all = [...(d ?? []), ...(r ?? [])].flatMap((x) => x.badges);
    return {
      node: new URLSearchParams(location.hash.split("?")[1] ?? "").get("node"),
      headRevisionId: revSpan?.getAttribute("title") ?? null,
      direct: d,
      reverse: r,
      pending: all.filter((b) => b.startsWith("checking")).length,
      linksHeading: direct ? ([...direct.querySelectorAll("p")].find((p) => /^links \(/.test(p.textContent.trim()))?.textContent.trim() ?? null) : null,
    };
  },

  // The lifecycle gate as the Knowledge view renders it on a node.
  gate: () => {
    const banner = document.querySelector('[role="status"]');
    const fieldset = document.querySelector("main fieldset");
    const btn = (t) => [...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === t) ?? null;
    const title = document.querySelector('input[placeholder="title…"]');
    return {
      banner: banner?.textContent ?? null,
      successorHref: banner?.querySelector("a")?.getAttribute("href") ?? null,
      fieldsetDisabled: fieldset?.disabled ?? null,
      publishDisabled: btn("publish revision")?.matches(":disabled") ?? null,
      correctDisabled: btn("record correction")?.matches(":disabled") ?? null,
      titleDisabled: title?.matches(":disabled") ?? null,
    };
  },

  lifecycleOutcome: () => {
    const sec = [...document.querySelectorAll("h3")].find((h) => h.textContent.trim() === "Lifecycle actions")?.parentElement;
    return { text: sec?.textContent ?? null, eligibility: document.body.textContent.match(/not eligible[^.]{0,40}/)?.[0] ?? null };
  },

  // The chat answer panel, plus a whole-document scan for a string that must
  // never reach the page (the secret session's canary).
  chat: (canary) => {
    const sec = [...document.querySelectorAll("h2")].find((h) => h.textContent.trim() === "Ask as peer")?.parentElement;
    if (!sec) return { ok: false, why: "no Ask as peer panel" };
    const box = sec.querySelector("div.rounded.border.bg-panel");
    const error = sec.querySelector('[role="alert"]')?.textContent ?? [...sec.querySelectorAll("p")].map((p) => p.textContent).find((t) => /writer_unavailable|model|error|failed/i.test(t) && !/Answers come from/i.test(t)) ?? null;
    const html = document.documentElement.outerHTML;
    return {
      asking: [...sec.querySelectorAll("button")].some((b) => b.textContent.trim() === "Asking..."),
      answer: box?.querySelector("p.whitespace-pre-wrap")?.textContent ?? null,
      coverage: box ? [...box.querySelectorAll("span")].map((s) => s.textContent.trim()).find((t) => /coverage$/.test(t)) ?? null : null,
      itemsUsed: box ? [...box.querySelectorAll("li.font-mono")].map((li) => li.textContent.trim()) : [],
      boxText: box?.textContent ?? null,
      error,
      canaryInPage: canary !== "" && html.includes(canary),
    };
  },

  search: () => {
    const buttons = [...document.querySelectorAll("button")].filter((b) => b.closest("li"));
    return {
      q: new URLSearchParams(location.hash.split("?")[1] ?? "").get("q"),
      input: document.querySelector('input[type="search"], input[placeholder*="search" i]')?.value ?? null,
      hits: buttons.map((b) => b.textContent.trim()).slice(0, 10),
      bodyText: document.querySelector("main")?.textContent?.slice(0, 1500) ?? document.body.textContent.slice(0, 1500),
    };
  },

  // A real API call from the page, with the same bearer the UI holds -- used
  // for the writes the UI does not offer (an `unresolved` citation) and for
  // reading raw rows to compare byte-for-byte.
  api: async ({ method, body }) => {
    const token = localStorage.getItem("arra-ui-v2-token") ?? "";
    const res = await fetch(`/api/knowledge/default/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* raw */ }
    return { status: res.status, json, text: json === null ? text.slice(0, 400) : null };
  },

  taxonomy: () => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("arra-ui-v2-taxonomy"));
    return key ? JSON.parse(localStorage.getItem(key)) : null;
  },
};
