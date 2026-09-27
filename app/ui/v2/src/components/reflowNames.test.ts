/** Failing-first RENDER guard (#33 AC2 round 7, verifier wave 7).
 *
 * Round 6 wrapped every text element the round-5 source guard could see, but
 * three flex items holding user- or operator-typed names still had no wrap
 * rule, so a long unbroken name kept its full min-content width:
 *  - LifecycleBanner's "open successor" link. Measured live: a successor
 *    titled with a GitHub URL made the Knowledge scroller 311/629 at 320px
 *    and 365/629 at 375px (the verifier's blocking finding);
 *  - ExploreView's workspace breadcrumb;
 *  - HealthLine's bank and workspace names.
 * Each element must carry `min-w-0` (a flex item's min-width is otherwise
 * its content) and `[overflow-wrap:anywhere]` (the only wrap rule that also
 * lowers min-content). `bun test src/components/reflowNames.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExploreView } from "../explore/ExploreView";
import { HealthLine } from "../overview/HealthLine";
import { LifecycleBanner } from "./LifecycleBanner";

const URL_TITLE =
  "ดูที่ https://github.com/Soul-Brews-Studio/arra-oracle-v4/blob/0ccda6a0ccda6a0ccda6a0ccda6a0ccda6a0ccda/app/server/src/knowledge/service.publishRevision.ts#L120";
const LONG_NAME = "workspace-without-any-break-opportunity-" + "x".repeat(120);
const WRAP = "[overflow-wrap:anywhere]";

/** The class list of the innermost element whose text contains `needle`. */
function classesAround(html: string, needle: string): string[] {
  const at = html.indexOf(needle);
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<", at);
  return (html.slice(open, at).match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
}

describe("long names wrap instead of widening their flex row", () => {
  test("LifecycleBanner: the successor link and the explanation wrap", () => {
    const html = renderToStaticMarkup(
      createElement(LifecycleBanner, {
        gate: {
          state: "superseded",
          blocked: true,
          label: "superseded",
          explanation: `Superseded by ${URL_TITLE}`,
          successor: { node_id: "node2aaaaaaaaaaaaaaaa", revision_id: null, title: URL_TITLE },
        },
      }),
    );
    const link = classesAround(html, `open successor: ${URL_TITLE}`);
    expect(link).toContain("min-w-0");
    expect(link).toContain(WRAP);
    expect(classesAround(html, `Superseded by ${URL_TITLE}`)).toContain(WRAP);
  });

  test("ExploreView: the workspace breadcrumb wraps", () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(ExploreView, {
        bank: { bank: "default", workspace: LONG_NAME, token: "" },
        selectedPeer: null,
        selectedSession: null,
        selectedNode: null,
        activeTab: "messages",
        onSelectPeer: noop,
        onSelectSession: noop,
        onSelectNode: noop,
        onTabChange: noop,
        onBack: noop,
        onOpenSearchHit: noop,
      }),
    );
    const crumb = classesAround(html, LONG_NAME);
    expect(crumb).toContain("min-w-0");
    expect(crumb).toContain(WRAP);
  });

  test("HealthLine: the bank and workspace names wrap", () => {
    const html = renderToStaticMarkup(
      createElement(HealthLine, { bank: `bank-${LONG_NAME}`, workspace: LONG_NAME, version: "v", auth: "bearer" }),
    );
    const bankSpan = classesAround(html, `bank-${LONG_NAME}`);
    expect(bankSpan).toContain("min-w-0");
    expect(bankSpan).toContain(WRAP);
    // The workspace name sits in a text-only span inside a titled wrapper; the
    // wrapper is the flex item, so it is the one that must shrink and wrap.
    const at = html.indexOf(`>${LONG_NAME}<`);
    const wrapper = html.lastIndexOf('<span title="the workspace', at);
    const wrapperClasses = (html.slice(wrapper, html.indexOf(">", wrapper)).match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
    expect(wrapperClasses).toContain("min-w-0");
    expect(wrapperClasses).toContain(WRAP);
  });
});
