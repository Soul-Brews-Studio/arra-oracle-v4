/** Failing-first RENDER tests for #33 AC1 cite/correct and lifecycle gating.
 *  `renderToStaticMarkup` + `createElement`, the same no-DOM, no-dependency
 *  pattern as `evidencePanels.test.ts`. Each block pins one piece of WIRING:
 *  reverting it (PublishForm without the link editor, the write panel ignoring
 *  the lifecycle gate, the banner not linking the successor) turns it red. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RevisionRow } from "../api/knowledge";
import type { LifecycleGate } from "../state/lifecycleGate";
import { LifecycleBanner } from "./LifecycleBanner";
import { LinkEditor } from "./LinkEditor";
import { NodeWritePanel } from "./NodeWritePanel";
import { PublishForm } from "./PublishForm";

const NODE = "nodeAAAAAAAAAAAAAAAAA";
const SUCC = "nodeBBBBBBBBBBBBBBBBB";

const head = {
  id: "revAAAAAAAAAAAAAAAAAA",
  node_id: NODE,
  revision_no: "2",
  title: "port note",
  body: "47777",
} as RevisionRow;

const active: LifecycleGate = { state: "active", blocked: false, label: null, explanation: null, successor: null };
const superseded: LifecycleGate = {
  state: "superseded",
  blocked: true,
  label: "superseded",
  explanation: "This node was superseded by “port note v2” (reason: moved).",
  successor: { node_id: SUCC, revision_id: "revBBBBBBBBBBBBBBBBBB", title: "port note v2" },
};

const panel = (gate: LifecycleGate) =>
  renderToStaticMarkup(
    createElement(NodeWritePanel, {
      gate,
      nodeId: NODE,
      head,
      revisions: [head],
      citeTargets: [],
      publishing: false,
      taxonomyReady: true,
      onPublish: () => {},
      onCorrect: () => {},
      mintId: () => "corrNNNNNNNNNNNNNNNNN",
    }),
  );

const disabledButton = (html: string, text: string) =>
  new RegExp(`<button[^>]*disabled=""[^>]*>[^<]*${text}`).test(html);

describe("PublishForm cites", () => {
  test("the publish form carries an evidence-link editor", () => {
    const html = renderToStaticMarkup(
      createElement(PublishForm, { onPublish: () => {}, publishing: false, disabled: false, editingNode: true, citeTargets: [] }),
    );
    expect(html).toContain("evidence links");
    expect(html).toContain("add evidence link");
  });
});

describe("LinkEditor", () => {
  test("offers revisions the UI already loaded, and shows a bad id's problem inline", () => {
    const html = renderToStaticMarkup(
      createElement(LinkEditor, {
        drafts: [{ relation: "supports", target_kind: "node_revision", fields: { node_id: NODE, revision_id: "short" }, note: "" }],
        onChange: () => {},
        citeTargets: [{ node_id: NODE, revision_id: head.id, revision_no: "2", title: "port note" }],
      }),
    );
    expect(html).toContain("port note");
    expect(html).toContain("revision_id");
    expect(html).toContain("21-character");
    for (const relation of ["supports", "contradicts", "derived_from", "discusses", "corrects", "related_to"]) {
      expect(html).toContain(`value="${relation}"`);
    }
    for (const kind of ["node_revision", "message", "session", "trace", "url"]) {
      expect(html).toContain(`value="${kind}"`);
    }
  });
});

describe("NodeWritePanel lifecycle gating", () => {
  test("a superseded node disables publish AND correct, with the explanation shown", () => {
    const html = panel(superseded);
    expect(html).toContain("<fieldset disabled=\"\"");
    expect(disabledButton(html, "publish revision")).toBe(true);
    expect(disabledButton(html, "record correction")).toBe(true);
    expect(html).toContain("This node was superseded");
  });

  test("an active node's forms are not fenced off", () => {
    const html = panel(active);
    expect(html).not.toContain("disabled=\"\"><");
    expect(html).not.toContain("<fieldset disabled");
    expect(html).toContain("record correction");
  });

  test("the Correct interaction explains what it does before you use it", () => {
    const html = panel(active);
    expect(html).toContain("correction");
    expect(html).toContain("corrects");
    expect(html).toContain("new node");
  });

  test("no Correct on a draft: there is no accepted revision to point at", () => {
    const html = renderToStaticMarkup(
      createElement(NodeWritePanel, {
        gate: active,
        nodeId: NODE,
        head: null,
        revisions: [],
        citeTargets: [],
        publishing: false,
        taxonomyReady: true,
        onPublish: () => {},
        onCorrect: () => {},
        mintId: () => "corrNNNNNNNNNNNNNNNNN",
      }),
    );
    expect(html).not.toContain("record correction");
    expect(html).toContain("create node");
  });
});

describe("LifecycleBanner", () => {
  test("labels a superseded node and links its successor", () => {
    const html = renderToStaticMarkup(createElement(LifecycleBanner, { gate: superseded }));
    expect(html).toContain("superseded");
    expect(html).toContain(`href="#/knowledge?node=${SUCC}"`);
    expect(html).toContain("port note v2");
  });

  test("labels a retired node without inventing a successor", () => {
    const html = renderToStaticMarkup(
      createElement(LifecycleBanner, {
        gate: { state: "retired", blocked: true, label: "retired", explanation: "This node was retired (reason: wrong).", successor: null },
      }),
    );
    expect(html).toContain("retired");
    expect(html).not.toContain("href=");
  });

  test("renders nothing for an active node", () => {
    expect(renderToStaticMarkup(createElement(LifecycleBanner, { gate: active }))).toBe("");
  });
});
