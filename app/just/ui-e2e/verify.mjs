// The read half of the #33 run: the evidence labels a supersede and a
// retire produce (AC3), an unresolvable citation, the byte-identical history
// of revision 1 (AC3), peer-context chat with citations and partial coverage
// (AC1), and Thai keyword search. Runs after `runChain` on the same `ctx`.
import { DIFF_1_VS_2, TEXT } from "./chain.mjs";
import { pageProbes as P } from "./probes.mjs";

const nid = () => {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  return Array.from({ length: 21 }, () => a[Math.floor(Math.random() * a.length)]).join("");
};
const need = (ctx, key) => {
  if (ctx[key] === undefined || ctx[key] === null) throw new Error(`missing ${key} (an earlier step failed)`);
  return ctx[key];
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function evidenceOf(h, node, label, ready) {
  await h.go(`#/explore?node=${node}&tab=evidence`);
  await h.waitDom(label, (n) => {
    if (new URLSearchParams(location.hash.split("?")[1] ?? "").get("node") !== n) return null;
    const t = document.body.textContent;
    return !t.includes("checking target") && !t.includes("checking citing") && !t.includes("loading…");
  }, node);
  const ev = await h.waitDom(`${label} rows`, ready, undefined, 20000).then(() => h.page.evaluate(P.evidence));
  return ev;
}

function termSnapshot(tax) {
  return JSON.stringify([{
    term_id: tax.type.terms.note, vocabulary_id: tax.type.vocabulary_id,
    vocabulary_name_snapshot: "type", term_name_snapshot: "note", label_snapshot: null, position: "0",
  }]);
}

function link(position, target_kind, target, capture_status, note) {
  return { position: String(position), relation: "related_to", target_kind, target, excerpt: null, content_hash: null, captured_at: null, capture_status, note };
}

export async function runVerify(h, ctx, cfg) {
  await h.step("evidence-after-supersede", async () => {
    const A1 = need(ctx, "A1"), A2 = need(ctx, "A2"), B = need(ctx, "B");
    const ev = await evidenceOf(h, B, "B evidence", () => document.body.textContent.includes("target superseded/retired"));
    const l1 = ev.direct.find((r) => r.text.includes(A2));
    const l2 = ev.direct.find((r) => r.text.includes(A1));
    if (!same(l1?.badges, ["locator only", "target superseded/retired"])) throw new Error(`A#2 link: ${JSON.stringify(l1?.badges)}`);
    if (!same(l2?.badges, ["locator only", "stale: not head", "target superseded/retired"])) throw new Error(`A#1 link: ${JSON.stringify(l2?.badges)}`);
    await h.shot("07-direct-evidence-after-supersede", "Direct evidence");
    const rv = await evidenceOf(h, need(ctx, "A"), "A evidence", () => document.body.textContent.includes("citing node superseded/retired"));
    const byWho = Object.fromEntries(rv.reverse.map((r) => [r.who, r]));
    const want = {
      [B]: ["locator only", "citing node current"],
      [need(ctx, "C")]: ["locator only", "citing node current"],
      [need(ctx, "D")]: ["locator only", "citing node superseded/retired"],
    };
    for (const [who, badges] of Object.entries(want)) {
      if (!same(byWho[who]?.badges, badges)) throw new Error(`reverse ${who}: ${JSON.stringify(byWho[who]?.badges)} != ${JSON.stringify(badges)}`);
    }
    if (!byWho[ctx.C].text.includes("corrects")) throw new Error("C's reverse row is not a corrects link");
    await h.shot("08-reverse-evidence-after-supersede", "Reverse evidence");
    return "B->A#2: target superseded/retired; B->A#1: stale: not head + target superseded/retired; A<-D: citing node superseded/retired; A<-B,C: citing node current";
  });

  // The UI's link editor only writes `locator_only` (buildLinkSnapshot), so
  // `unresolved` and "target unavailable" can only come from another writer.
  // This publishes one through the real HTTP API, then reads it in the UI.
  await h.step("evidence-unresolved", async () => {
    const tax = need(ctx, "taxonomy");
    const E = nid();
    const content = {
      workspace_name: "default", node_id: E, base_revision_id: null,
      title: "Imported note with unresolvable citations", body: "Written by another client; its citations could not be resolved.",
      body_format: "text", fields: "{}", author_peer_name: null, observer_peer_name: null, subject_peer_name: null,
      session_name: null, is_active: true, valid_from: null, valid_to: null, change_reason: null,
      schema_version: "1", canonical_version: "arra-revision/v1", term_snapshot_json: termSnapshot(tax),
      link_snapshot_json: JSON.stringify([
        link(0, "node_revision", { node_id: nid(), revision_id: nid() }, "unresolved", "a revision that does not exist"),
        link(1, "url", { url: "https://example.invalid/gone" }, "unresolved", "dead link"),
      ]),
      h_metadata: null, internal_metadata: null,
    };
    let res = await h.page.evaluate(P.api, { method: "publishRevision", body: { operation_id: nid(), content } });
    let unavailableReachable = true;
    const res0 = `${res.status} ${res.json?.code ?? ""}`.trim();
    if (res.status !== 200) {
      // Record exactly what the server said, then fall back to the one
      // unresolved citation it does accept.
      console.log(`NOTE publishRevision with a dangling node_revision target -> ${res.status} ${JSON.stringify(res.json ?? res.text).slice(0, 200)}`);
      unavailableReachable = false;
      content.link_snapshot_json = JSON.stringify([link(0, "url", { url: "https://example.invalid/gone" }, "unresolved", "dead link")]);
      res = await h.page.evaluate(P.api, { method: "publishRevision", body: { operation_id: nid(), content } });
      if (res.status !== 200) throw new Error(`publishRevision (url unresolved) -> ${res.status} ${JSON.stringify(res.json ?? res.text).slice(0, 200)}`);
    }
    ctx.E = E;
    const ev = await evidenceOf(h, E, "E evidence", () => document.body.textContent.includes("unresolved"));
    const url = ev.direct.find((r) => r.text.includes("example.invalid/gone"));
    if (!same(url?.badges, ["unresolved"])) throw new Error(`url row ${JSON.stringify(url?.badges)}`);
    if (unavailableReachable) {
      const nr = ev.direct.find((r) => r.text.includes("node_revision"));
      if (!same(nr?.badges, ["unresolved", "target unavailable"])) throw new Error(`dangling node_revision row ${JSON.stringify(nr?.badges)}`);
    }
    await h.shot("09-unresolved-evidence", "Direct evidence");
    ctx.unavailable = unavailableReachable ? "shown" : res0;
    return `E=${E}: url cited as unresolved -> badge "unresolved"${unavailableReachable ? "; dangling node_revision -> unresolved + target unavailable" : ""}`;
  });

  // "target unavailable" needs a node_revision citation whose target the
  // server has no accepted revision for. publishRevision refuses exactly
  // that (invalid_reference), and revisions are never deleted, so no real
  // write reaches it: this is reported, never passed.
  await h.step("evidence-target-unavailable", async () => {
    if (ctx.unavailable === "shown") return "dangling node_revision labelled target unavailable";
    if (ctx.unavailable === undefined) throw new Error("missing unavailable probe (an earlier step failed)");
    return { skip: `unreachable through a real write: publishRevision -> ${ctx.unavailable}` };
  });

  await h.step("history-byte-identical", async () => {
    const A = need(ctx, "A"), rev1Dom = need(ctx, "rev1Dom"), rev1Row = need(ctx, "rev1Row");
    await h.go(`#/knowledge?node=${A}`);
    await h.waitDom("A history", (t) => document.querySelector("main h2")?.textContent === t && document.body.textContent.includes("diff"), TEXT.a2.title);
    await h.act(DIFF_1_VS_2);
    await h.waitDom("diff from rev 1", P.diffFrom);
    const dom = await h.page.evaluate(P.diffFrom);
    if (!same(dom, rev1Dom)) throw new Error(`rev 1 as rendered changed:\n before ${JSON.stringify(rev1Dom)}\n after  ${JSON.stringify(dom)}`);
    if (dom.title !== TEXT.a1.title) throw new Error("rev 1 title is not what was typed");
    const rows = await h.page.evaluate(P.api, { method: "listAcceptedHistory", body: { workspace_name: "default", node_id: A } });
    const list = rows.json?.rows ?? rows.json?.revisions ?? rows.json;
    const r1 = list.find((r) => String(r.revision_no) === "1");
    const now = { title: r1.title, body: r1.body, term_snapshot_json: r1.term_snapshot_json, link_snapshot_json: r1.link_snapshot_json, content_digest: r1.content_digest };
    for (const k of Object.keys(rev1Row)) {
      if (now[k] !== rev1Row[k]) throw new Error(`rev 1 ${k} changed: ${JSON.stringify(rev1Row[k])} -> ${JSON.stringify(now[k])}`);
    }
    await h.shot("10-history-rev1-unchanged", "diff");
    return `rev 1 title/body/terms identical in the DOM and in listAcceptedHistory (${Object.keys(rev1Row).join(", ")}) after revise, cite, correct, retire and supersede`;
  });

  await h.step("chat-peer-context", async () => {
    if (!cfg.ollamaUp) return { skip: `Ollama unreachable at ${cfg.ollamaBase}` };
    await h.go(`#/messages?peer=${cfg.peer}&session=${cfg.session}`);
    await h.waitDom("ask panel enabled", () => {
      const sec = [...document.querySelectorAll("h2")].find((x) => x.textContent.trim() === "Ask as peer")?.parentElement;
      const ta = sec?.querySelector("textarea");
      return ta && !ta.disabled;
    });
    await h.act([
      { root: "ask", fill: "textarea", value: "What should I remember to do before a disk migration?" },
      { root: "ask", click: "Ask" },
    ]);
    const c = await h.waitDom("chat answer", (canary) => {
      const sec = [...document.querySelectorAll("h2")].find((x) => x.textContent.trim() === "Ask as peer")?.parentElement;
      const box = sec?.querySelector("div.rounded.border.bg-panel");
      const asking = [...(sec?.querySelectorAll("button") ?? [])].some((b) => b.textContent.trim() === "Asking...");
      if (asking) return null;
      return box ? true : { ok: false, text: sec?.textContent?.slice(0, 300), canary };
    }, cfg.canary, 180000).then(() => h.page.evaluate(P.chat, cfg.canary));
    const bad = [];
    if (!c.answer || c.answer.trim() === "") bad.push("empty answer");
    if (c.coverage !== "partial coverage") bad.push(`coverage label ${JSON.stringify(c.coverage)}`);
    if (!/unauthorized/.test(c.boxText ?? "")) bad.push("excluded list does not show the unauthorized session");
    if (c.itemsUsed.length === 0) bad.push("no citations (items_used)");
    const stray = c.itemsUsed.filter((id) => !cfg.visibleMessageIds.includes(id));
    if (stray.length) bad.push(`citations outside the peer's sessions: ${stray}`);
    if (c.canaryInPage) bad.push("SECRET CANARY is in the page");
    if (bad.length) throw new Error(`${bad.join("; ")} :: ${JSON.stringify(c).slice(0, 500)}`);
    await h.shot("11-chat-partial-coverage");
    return `answer ${JSON.stringify(c.answer.slice(0, 80))}…; ${c.coverage}; citations ${c.itemsUsed.length} (all in ${cfg.session}); secret canary absent from the DOM`;
  });

  await h.step("search-thai-keyword", async () => {
    const B = need(ctx, "B");
    // Search is a separate step from publish (#30, "index first"): index B's
    // head through the real API, exactly as the CLI's `kb indexRevisionChunks`.
    const head = await h.page.evaluate(P.api, { method: "getAcceptedHead", body: { workspace_name: "default", node_id: B } });
    const revisionId = head.json?.revision?.id ?? head.json?.id;
    const idx = await h.page.evaluate(P.api, {
      method: "indexRevisionChunks",
      body: { workspace_name: "default", node_id: B, revision_id: revisionId, chunker_version: "chunker/v1", embedding_profile: { name: "ollama/all-minilm/384/none", dims: 384 } },
    });
    if (idx.status !== 200) throw new Error(`indexRevisionChunks -> ${idx.status} ${JSON.stringify(idx.json ?? idx.text).slice(0, 200)}`);
    await h.go(`#/explore?tab=search&q=${encodeURIComponent("ลืม")}&mode=keyword`);
    const s = await h.waitDom("Thai keyword hit", (t) => {
      const hit = [...document.querySelectorAll("li button")].find((b) => b.textContent.includes(t));
      return hit ? { hit: hit.textContent.slice(0, 120) } : null;
    }, TEXT.b.title);
    await h.shot("12-search-thai-keyword");
    return `ลืม -> ${JSON.stringify(s.hit)}`;
  });
}
