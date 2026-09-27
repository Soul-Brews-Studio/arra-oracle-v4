// The label half of #33 AC3: a revision keeps the label it was published
// with, even after the term behind that label is renamed and the node is
// edited again. A's revisions cannot show this -- the UI writes only the
// sealed `type`/`memory_horizon` terms, and renameTerm refuses sealed
// vocabularies -- so node L carries an OPEN `topic` term:
//
//   rev 1 (API)  type:note + topic:storage       <- the snapshot under test
//   renameTerm   storage -> persistence          (live name changes)
//   rev 2 (API)  type:note + topic:persistence   (the server requires the
//                                                 CURRENT name on new content)
//   rev 3 (UI)   a later edit through the publish form (drops the topic)
//
// Then, in the DOM, the #1 vs #2 diff must read `~ topic:storage →
// topic:persistence` and #1 vs #3 must read `− topic:storage`: rev 1's side
// is its own snapshot, never the live name. A UI that rendered live labels
// would show `persistence` on rev 1's side and fail here. The raw
// `term_snapshot_json` of rev 1 is also compared byte-for-byte with what was
// read back right after it was published.
import { diffPair } from "./diffPair.mjs";
import { need } from "./need.mjs";
import { nid } from "./nid.mjs";
import { probes as P } from "./probes.mjs";
import { text as TEXT } from "./text.mjs";

const WS = "default";

// Page-side: the diff's rev numbers and the term-change lines as rendered.
function termDiff() {
  const ps = [...document.querySelectorAll("p")];
  const head = ps.find((p) => /^terms \(\d+\)$/.test(p.textContent.trim()));
  const from = ps.find((p) => /^from · rev /.test(p.textContent.trim()));
  const to = ps.find((p) => /^to · rev /.test(p.textContent.trim()));
  if (!head || !from || !to) return { ok: false, why: "no revision diff on screen" };
  return {
    from: from.textContent.trim(),
    to: to.textContent.trim(),
    fromTitle: from.nextElementSibling?.getAttribute("title") ?? null,
    heading: head.textContent.trim(),
    items: [...head.parentElement.querySelectorAll("li")].map((li) => li.textContent.trim()),
  };
}

export async function historicLabels(h, ctx) {
  await h.step("history-labels-after-rename", async () => {
    const tax = need(ctx, "taxonomy");
    const call = async (method, body) => {
      const r = await h.page.evaluate(P.api, { method, body });
      if (r.status !== 200) throw new Error(`${method} -> ${r.status} ${JSON.stringify(r.json ?? r.text).slice(0, 200)}`);
      return r.json;
    };
    const rows = async (node) => {
      const r = await call("listAcceptedHistory", { workspace_name: WS, node_id: node });
      const list = r?.rows ?? r?.revisions ?? r;
      if (!Array.isArray(list)) throw new Error(`listAcceptedHistory: ${JSON.stringify(r).slice(0, 200)}`);
      return (no) => list.find((x) => String(x.revision_no) === String(no));
    };
    const vocab = nid(), term = nid(), L = nid();
    await call("createVocabulary", {
      workspace_name: WS, vocabulary_id: vocab, name: "topic", label: "Topic", description: null,
      kind: "tags", term_policy: "open", cardinality: "many", required: false, hierarchy: "flat",
    });
    await call("createTerm", { workspace_name: WS, term_id: term, vocabulary_id: vocab, name: "storage", description: null, parent_id: null });
    const terms = (topic) => JSON.stringify([
      { term_id: tax.type.terms.note, vocabulary_id: tax.type.vocabulary_id, vocabulary_name_snapshot: "type", term_name_snapshot: "note", label_snapshot: null, position: "0" },
      { term_id: term, vocabulary_id: vocab, vocabulary_name_snapshot: "topic", term_name_snapshot: topic, label_snapshot: null, position: "1" },
    ]);
    const content = (base, t, topic) => ({
      workspace_name: WS, node_id: L, base_revision_id: base, title: t.title, body: t.body,
      body_format: "text", fields: "{}", author_peer_name: null, observer_peer_name: null, subject_peer_name: null,
      session_name: null, is_active: true, valid_from: null, valid_to: null, change_reason: null,
      schema_version: "1", canonical_version: "arra-revision/v1", term_snapshot_json: terms(topic),
      link_snapshot_json: "[]", h_metadata: null, internal_metadata: null,
    });

    await call("publishRevision", { operation_id: nid(), content: content(null, TEXT.l1, "storage") });
    const r1 = (await rows(L))(1);
    if (!r1?.term_snapshot_json?.includes('"term_name_snapshot":"storage"')) throw new Error(`rev 1 terms ${r1?.term_snapshot_json}`);
    const pinned = { title: r1.title, body: r1.body, term_snapshot_json: r1.term_snapshot_json, content_digest: r1.content_digest };
    await call("renameTerm", { workspace_name: WS, term_id: term, expected_name: "storage", name: "persistence" });
    await call("publishRevision", { operation_id: nid(), content: content(r1.id, TEXT.l2, "persistence") });

    // rev 3: a later edit through the UI's own publish form.
    await h.go(`#/knowledge?node=${L}`);
    await h.waitDom("L loaded at #2", (t) => document.querySelector("main h2")?.textContent === t, TEXT.l2.title);
    await h.act([
      { root: "publish", fill: 'input[placeholder="title…"]', value: TEXT.l3.title },
      { root: "publish", fill: 'textarea[placeholder="body…"]', value: TEXT.l3.body },
      { root: "publish", fill: 'input[placeholder="change reason (optional)…"]', value: TEXT.l3.reason },
      { root: "publish", click: "publish revision" },
    ]);
    await h.waitDom("L head #3", (t) => document.querySelector("main h2")?.textContent === t, TEXT.l3.title);

    const want12 = ["~ topic:storage → topic:persistence"];
    await h.act(diffPair("#1", "#2"));
    const d12 = await h.waitDom("#1 vs #2 term diff", termDiff);
    if (d12.from !== "from · rev 1" || d12.to !== "to · rev 2") throw new Error(`picked ${d12.from} / ${d12.to}`);
    if (JSON.stringify(d12.items) !== JSON.stringify(want12)) throw new Error(`#1 vs #2 terms ${JSON.stringify(d12.items)} != ${JSON.stringify(want12)}`);
    if (d12.fromTitle !== TEXT.l1.title) throw new Error(`rev 1 title as rendered ${JSON.stringify(d12.fromTitle)}`);
    await h.shot("13-history-label-after-rename", "diff");

    await h.act(diffPair("#1", "#3"));
    const d13 = await h.waitDom("#1 vs #3 term diff", termDiff);
    if (d13.from !== "from · rev 1" || d13.to !== "to · rev 3") throw new Error(`picked ${d13.from} / ${d13.to}`);
    if (!d13.items.includes("− topic:storage") || d13.items.some((x) => x.includes("persistence"))) {
      throw new Error(`#1 vs #3 terms ${JSON.stringify(d13.items)}: rev 1 must show its own snapshot topic:storage`);
    }

    const now = (await rows(L))(1);
    for (const k of Object.keys(pinned)) {
      if (now[k] !== pinned[k]) throw new Error(`rev 1 ${k} changed: ${JSON.stringify(pinned[k])} -> ${JSON.stringify(now[k])}`);
    }
    return `L=${L}: after renameTerm storage->persistence and 2 later edits (API #2, UI #3), rev 1 renders topic:storage (#1 vs #2 ${JSON.stringify(d12.items[0])}; #1 vs #3 ${JSON.stringify(d13.items)}); rev 1 title/body/term_snapshot_json/content_digest byte-identical`;
  });
}
