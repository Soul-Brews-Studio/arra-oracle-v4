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
import { CorrectForm } from "./CorrectForm";
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

  // Wave 5 hardening (#33): mutant M4 replaced PublishForm.tsx:50's
  // `links: built.entries` with `links: []` and every prior test stayed
  // green -- nothing drove submit() and read what onPublish received. This
  // test does exactly that, with no DOM: `initialLinks`/`submitRef` are
  // test-only seams (see PublishForm.tsx doc comment) that fill a link row
  // and invoke the real submit closure directly.
  test("submit sends the link editor's built entries to onPublish (pins PublishForm.tsx `links: built.entries`)", () => {
    const ref: { current: (() => void) | null } = { current: null };
    let received: import("./PublishForm").Draft | null = null;
    renderToStaticMarkup(
      createElement(PublishForm, {
        onPublish: (input) => {
          received = input;
        },
        publishing: false,
        disabled: false,
        editingNode: true,
        citeTargets: [],
        initialTitle: "port note",
        initialBody: "the port is 47778",
        initialLinks: [{ relation: "supports", target_kind: "url", fields: { url: "https://example.com" }, note: "" }],
        submitRef: ref,
      }),
    );
    expect(ref.current).not.toBeNull();
    ref.current!();
    expect(received).not.toBeNull();
    expect(received!.links.length).toBe(1);
    expect(received!.links[0]!.target_kind).toBe("url");
    expect(received!.links[0]!.target.url).toBe("https://example.com");
  });

  test("refuses type: correction without a corrects link, and says why (#33 TODO4)", () => {
    let received: unknown = "not called";
    const ref: { current: (() => void) | null } = { current: null };
    const html = renderToStaticMarkup(
      createElement(PublishForm, {
        onPublish: (input) => {
          received = input;
        },
        publishing: false,
        disabled: false,
        editingNode: true,
        citeTargets: [],
        initialTitle: "t",
        initialBody: "b",
        initialTypeTerm: "correction",
        submitRef: ref,
      }),
    );
    // canSubmit is false, so the button itself is disabled...
    expect(disabledButton(html, "publish revision")).toBe(true);
    expect(html).toContain("needs a corrects link");
    // ...and even a direct call to the captured submit closure (bypassing
    // the disabled attribute, exactly like a mutant that dropped the
    // `disabled` wiring would) must still refuse: the guard lives in
    // `submit()` itself (`if (!canSubmit ...) return`), not only in the
    // button's `disabled` prop.
    ref.current!();
    expect(received).toBe("not called");
  });

  // Fix round 3 (2026-09-27): the verifier's mutant
  // `built.entries.some((e) => e.relation === "corrects")` ->
  // `built.entries.length > 0` survived -- no test sent a correction whose
  // only link is some OTHER relation. This one does.
  test("a correction whose only link is not `corrects` is still refused", () => {
    let received: unknown = "not called";
    const ref: { current: (() => void) | null } = { current: null };
    const html = renderToStaticMarkup(
      createElement(PublishForm, {
        onPublish: (input) => {
          received = input;
        },
        publishing: false,
        disabled: false,
        editingNode: true,
        citeTargets: [],
        initialTitle: "t",
        initialBody: "b",
        initialTypeTerm: "correction",
        initialLinks: [{ relation: "supports", target_kind: "url", fields: { url: "https://example.com" }, note: "" }],
        submitRef: ref,
      }),
    );
    expect(disabledButton(html, "publish revision")).toBe(true);
    expect(html).toContain("needs a corrects link");
    ref.current!();
    expect(received).toBe("not called");
  });

  test("a corrects link on type: correction is accepted", () => {
    let received: import("./PublishForm").Draft | null = null;
    const ref: { current: (() => void) | null } = { current: null };
    renderToStaticMarkup(
      createElement(PublishForm, {
        onPublish: (input) => {
          received = input;
        },
        publishing: false,
        disabled: false,
        editingNode: true,
        citeTargets: [{ node_id: NODE, revision_id: head.id, revision_no: "2", title: "port note" }],
        initialTitle: "t",
        initialBody: "b",
        initialTypeTerm: "correction",
        initialLinks: [{ relation: "corrects", target_kind: "node_revision", fields: { node_id: NODE, revision_id: head.id }, note: "" }],
        submitRef: ref,
      }),
    );
    ref.current!();
    expect(received).not.toBeNull();
    expect(received!.links[0]!.relation).toBe("corrects");
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
    // NOTE: with the panel's default (empty title/body) `canSubmit` is
    // false on its own, so these two `disabledButton` checks pass under ANY
    // gate and prove nothing about the gate itself (wave 5 finding). The
    // fieldset assertion above is the real fence check; `disabled and
    // canSubmit really follow the gate` is pinned below with fields FILLED,
    // where only the gate can still disable the button.
    expect(disabledButton(html, "publish revision")).toBe(true);
    expect(disabledButton(html, "record correction")).toBe(true);
    expect(html).toContain("This node was superseded");
  });

  test("gate itself (not empty fields) disables PublishForm and CorrectForm: filled fields, blocked=true", () => {
    const publishHtml = renderToStaticMarkup(
      createElement(PublishForm, {
        onPublish: () => {},
        publishing: false,
        disabled: true,
        disabledReason: superseded.explanation ?? undefined,
        editingNode: true,
        citeTargets: [],
        initialTitle: "t",
        initialBody: "b",
      }),
    );
    expect(disabledButton(publishHtml, "publish revision")).toBe(true);

    const correctHtml = renderToStaticMarkup(
      createElement(CorrectForm, {
        revisions: [head],
        citeTargets: [],
        disabled: true,
        disabledReason: superseded.explanation ?? undefined,
        publishing: false,
        mintId: () => "corrNNNNNNNNNNNNNNNNN",
        onCorrect: () => {},
        initialTitle: "t",
        initialBody: "b",
      }),
    );
    expect(disabledButton(correctHtml, "record correction")).toBe(true);
  });

  test("gate itself (not empty fields) leaves PublishForm and CorrectForm enabled: filled fields, blocked=false", () => {
    const publishHtml = renderToStaticMarkup(
      createElement(PublishForm, {
        onPublish: () => {},
        publishing: false,
        disabled: false,
        editingNode: true,
        citeTargets: [],
        initialTitle: "t",
        initialBody: "b",
      }),
    );
    expect(disabledButton(publishHtml, "publish revision")).toBe(false);

    const correctHtml = renderToStaticMarkup(
      createElement(CorrectForm, {
        revisions: [head],
        citeTargets: [],
        disabled: false,
        publishing: false,
        mintId: () => "corrNNNNNNNNNNNNNNNNN",
        onCorrect: () => {},
        initialTitle: "t",
        initialBody: "b",
      }),
    );
    // This is the assertion that catches a mutant dropping CorrectForm's
    // own `!disabled` clause from `canSubmit` (M14): with the outer
    // fieldset absent here, only CorrectForm's own gating can disable it.
    expect(disabledButton(correctHtml, "record correction")).toBe(false);
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
