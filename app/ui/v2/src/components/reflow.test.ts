/** Failing-first RENDER test (#33 AC2 round 4, blocking finding): at 375px a
 *  long title or code path still made the user scroll SIDEWAYS inside a view.
 *  Round 3 made each view root the page's one scroll container, so the
 *  overflow sat inside that container, where `document.documentElement
 *  .scrollWidth` cannot see it. Three sources, measured live by the verifier:
 *  - a `<select>` sizes to its longest option. The "revision to correct"
 *    select (CorrectForm) and the diff from/to selects (Knowledge) list
 *    `#N — <title>`, so one 114-char Thai/English title made a 671px select
 *    and a 210-char one a 1219px select (also sideways at 1440);
 *  - a message is `whitespace-pre-wrap` with no overflow-wrap, so an 88-char
 *    path overflowed the transcript (Explore > Messages, Messages, Forum).
 *
 * What this pins: every `<select>` that can list a title is capped at its
 * container (`min-w-0 max-w-full`), and message text may break anywhere.
 * Whether that is ENOUGH is measured live, by scanning every inner scroller
 * for `scrollWidth > clientWidth` -- see docs/overnight/UI-PROOF-ui-a11y.md
 * "Round 4". That scan, run at 320px (WCAG 1.4.10's reference width), also
 * found two rows the verifier's 375px pass could not: Explore's count strip
 * (its "refresh all" button ended at 360px) and the Overview probe grid (a
 * bare `minmax(20rem,…)` track is 320px before padding).
 * `bun test src/components/reflow.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RevisionRow } from "../api/knowledge";
import type { MessageRow as MessageRowType } from "../api/memory";
import { CountStrip } from "../explore/CountStrip";
import { OverviewView } from "../overview/OverviewView";
import { CorrectForm } from "./CorrectForm";
import { LinkEditor } from "./LinkEditor";
import { MessageRow } from "./MessageRow";
import { RevisionDiffPicker } from "./RevisionDiffPicker";
import { ThreadNode } from "./ThreadNode";

const PATH = "/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/app/server/src/knowledge/service.publishRevision.ts";
const TITLE = `ผ่าดิสก์อย่างปลอดภัย: snapshot ก่อนซ้อมย้ายข้อมูลทุกครั้ง -- see ${PATH}`;

const rev = (n: string): RevisionRow =>
  ({ id: `rev${n}AAAAAAAAAAAAAAAAA`, node_id: "nodeAAAAAAAAAAAAAAAAA", revision_no: n, title: TITLE, body: "b" }) as RevisionRow;

/** The class lists of every `<select>` in `html`. */
function selectClasses(html: string): string[][] {
  return [...html.matchAll(/<select[^>]*>/g)].map((m) => (m[0].match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/));
}

function expectCappedSelects(html: string, count: number) {
  const selects = selectClasses(html);
  expect(selects.length).toBe(count);
  for (const cls of selects) {
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("max-w-full");
  }
}

describe("selects that list a revision title never grow past their container", () => {
  test("CorrectForm: the 'revision to correct' select", () => {
    const html = renderToStaticMarkup(
      createElement(CorrectForm, {
        revisions: [rev("2"), rev("1")],
        citeTargets: [],
        disabled: false,
        publishing: false,
        mintId: () => "x",
        onCorrect: () => {},
      }),
    );
    expectCappedSelects(html, 1);
  });

  test("Knowledge diff: both the from and the to select", () => {
    const [to, from] = [rev("2"), rev("1")];
    const html = renderToStaticMarkup(
      createElement(RevisionDiffPicker, {
        revisions: [to, from],
        from,
        to,
        onFrom: () => {},
        onTo: () => {},
      }),
    );
    expectCappedSelects(html, 2);
  });

  test("LinkEditor: relation, kind and the loaded-revision (title) select", () => {
    const html = renderToStaticMarkup(
      createElement(LinkEditor, {
        drafts: [{ relation: "supports", target_kind: "node_revision", fields: {}, note: "" }],
        onChange: () => {},
        citeTargets: [{ node_id: "nodeAAAAAAAAAAAAAAAAA", revision_id: "revA", revision_no: "1", title: TITLE }],
      }),
    );
    expectCappedSelects(html, 3);
  });
});

const message = {
  public_id: "m1",
  peer_name: "peer-01",
  role: "user",
  seq_in_session: 1,
  created_at: "2026-09-27T00:00:00Z",
  content: `ข้อความ: ${PATH}`,
} as unknown as MessageRowType;

/** The class list of the element whose text is the message content. */
function contentClasses(html: string): string[] {
  const at = html.indexOf(message.content.slice(0, 8));
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<p", at);
  return (html.slice(open, at).match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
}

describe("message text wraps an unbroken path instead of widening the transcript", () => {
  test("MessageRow (Explore > Messages, Messages view)", () => {
    const html = renderToStaticMarkup(createElement(MessageRow, { message, highlighted: false }));
    expect(contentClasses(html)).toContain("[overflow-wrap:anywhere]");
  });

  test("ThreadNode (Forum)", () => {
    const html = renderToStaticMarkup(
      createElement(ThreadNode, {
        thread: { root: message, replies: [], depth: 0, orphaned: false },
        highlighted: new Set<string>(),
        onReply: () => {},
        replyingTo: null,
      } as unknown as Parameters<typeof ThreadNode>[0]),
    );
    expect(contentClasses(html)).toContain("[overflow-wrap:anywhere]");
  });
});

if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

describe("rows that did not reflow at 320px", () => {
  test("Explore's count strip wraps rather than pushing 'refresh all' off screen", () => {
    const html = renderToStaticMarkup(
      createElement(CountStrip, { peersTotal: "12", sessionsTotal: "12", nodesTotal: "1", onRefreshAll: () => {}, refreshing: false }),
    );
    const root = (html.match(/^<div class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
    expect(root).toContain("flex-wrap");
  });

  test("the Overview grid's track minimum never exceeds its container", () => {
    const html = renderToStaticMarkup(
      createElement(OverviewView, { bank: { bank: "default", workspace: "default", token: "" }, onGo: () => {} }),
    );
    expect(html).not.toContain("minmax(20rem,1fr)");
    expect(html).toContain("grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))]");
    // ...and the probe rows inside it: 7rem + 9rem floors + gaps outgrew a
    // 320px screen's card on their own.
    expect(html).not.toContain("minmax(7rem,1fr)");
    expect(html).toContain("grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)]");
  });
});
