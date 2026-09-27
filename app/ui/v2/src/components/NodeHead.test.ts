/** Failing-first RENDER test (#33 AC2 round 3). Measured live after the
 *  stacked-layout fix, on a published node with a Thai/English title and a
 *  40-line body: at 1440x900 `<main>` (the desktop column's scroller) was
 *  819px but the NodeHead body -- a SECOND `flex-1 overflow-y-auto` scroller
 *  nested inside it -- was 32px tall over 823px of content. A scroll
 *  container's automatic min-height is 0, so it was the one flex item that
 *  gave up its height to the revision history and write panel below it.
 *
 * Pinned: the node body is `flex-none` and not its own scroller; the column
 * it sits in (KnowledgeView's `<main>` from `lg`, the page below `lg`)
 * scrolls it. `bun test src/components/NodeHead.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NodeHead } from "./NodeHead";

const body = Array.from({ length: 40 }, (_, i) => `บรรทัด ${i + 1}: line ${i + 1}`).join("\n");
const html = renderToStaticMarkup(
  createElement(NodeHead, {
    node: { node_id: "n1" },
    revision: {
      id: "r1", node_id: "n1", revision_no: "1", base_revision_id: null, operation_id: "op",
      title: "ผ่าดิสก์อย่างปลอดภัย: a long Thai/English title", body, body_format: "markdown", fields: "{}",
      author_peer_name: null, observer_peer_name: null, subject_peer_name: null, session_name: null,
      is_active: true, valid_from: null, valid_to: null, change_reason: null,
      created_at: "2026-09-27T00:00:00.000Z", schema_version: "1", canonical_version: "arra-revision/v1",
      content_digest: "0".repeat(64),
    },
    loading: false,
    error: null,
  }),
);

describe("NodeHead is not a nested scroller that can collapse", () => {
  test("its root is flex-none, with no flex-1 and no overflow of its own", () => {
    const cls = (html.match(/^<div class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
    expect(cls).toContain("flex-none");
    expect(cls).not.toContain("flex-1");
    expect(cls).not.toContain("overflow-y-auto");
    expect(html).toContain("บรรทัด 40: line 40");
  });
});
