/** Failing-first RENDER + SOURCE guard (#33 AC2 round 5, verifier wave 6).
 *
 * Round 4 wrapped message text in MessageRow and ThreadNode and stopped
 * there. The verifier then found the same unbroken-token overflow in three
 * places no round-4 test could see, each measured live as a scroller whose
 * scrollWidth beat its clientWidth:
 *  - RevisionDiff's link list renders `JSON.stringify(entry)`, one ~230-char
 *    token (Knowledge scroller 310/984 at 320px, `<main>` 790/1224 at 1440);
 *  - NodeHead's body (`<pre>` for text, `<p>` for markdown) is
 *    whitespace-pre-wrap with no overflow-wrap, so a repo path in the body
 *    ran past a 320px column;
 *  - ContextPanel's assembled items, the same messages that now wrap in the
 *    transcript (App aside 365/670 at 375).
 * DialecticPanel's answer and TracePanel's excerpt had the same pattern.
 *
 * Two halves. The render tests pin `[overflow-wrap:anywhere]` on the element
 * holding each worst-case token (`anywhere`, not `break-words`: only
 * `anywhere` also lowers the min-content width, which is what a flex or grid
 * item sizes to). The source guard closes the class: every className in
 * src/ that keeps whitespace (`whitespace-pre*`) or sets `font-mono` -- the
 * idiom for ids, paths, digests and JSON -- and every `<pre>`/`<code>`, must
 * carry a wrap rule or `truncate`, unless it is a form control (an input
 * scrolls its own value). Whether that is ENOUGH is measured live, by the
 * inner-scroller scan in docs/overnight/UI-PROOF-ui-a11y.md "Round 5".
 * `bun test src/components/reflowText.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TraceHitRow, TraceRow } from "../api/evidenceReview";
import type { RevisionRow } from "../api/knowledge";
import type { ChatAnswer, ContextItem } from "../api/memory";
import { ContextItemRow } from "./ContextItemRow";
import { DialecticPanel } from "./DialecticPanel";
import { NodeHead } from "./NodeHead";
import { RevisionDiff } from "./RevisionDiff";
import { TracePanel } from "./TracePanel";

const REPO_PATH = "app/server/src/knowledge/service.publishRevision.ts:120";
const ABS_PATH = "/opt/Code/github.com/Soul-Brews-Studio/arra-oracle-v4/app/server/src/knowledge/service.publishRevision.ts";
const WRAP = "[overflow-wrap:anywhere]";

/** The class list of the innermost element whose text contains `needle`. */
function classesAround(html: string, needle: string): string[] {
  const at = html.indexOf(needle);
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<", at);
  return (html.slice(open, at).match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
}

function revision(over: Partial<RevisionRow>): RevisionRow {
  return {
    id: "rev1aaaaaaaaaaaaaaaaa",
    node_id: "node1aaaaaaaaaaaaaaaa",
    revision_no: "1",
    title: "t",
    body: "b",
    body_format: "markdown",
    content_digest: "0123456789abcdef0123456789abcdef",
    created_at: "2026-09-27T00:00:00.000000Z",
    is_active: true,
    term_snapshot_json: "[]",
    link_snapshot_json: "[]",
    ...over,
  } as RevisionRow;
}

describe("the verifier's three blocking sources wrap an unbroken token", () => {
  test("RevisionDiff: a ~230-char link JSON in the link-change list", () => {
    const link = {
      relation: "derived_from",
      target_kind: "code",
      target: JSON.stringify({ commit: "0ccda6a0ccda6a0ccda6a0ccda6a", path: ABS_PATH, repo: "Soul-Brews-Studio/arra-oracle-v4" }),
    };
    const html = renderToStaticMarkup(
      createElement(RevisionDiff, {
        from: revision({}),
        to: revision({ id: "rev2bbbbbbbbbbbbbbbbb", revision_no: "2", link_snapshot_json: JSON.stringify([link]) }),
      }),
    );
    expect(JSON.stringify(link).length).toBeGreaterThan(200);
    expect(classesAround(html, "service.publishRevision.ts")).toContain(WRAP);
  });

  test("NodeHead: a markdown body holding a repo path and an absolute path", () => {
    const html = renderToStaticMarkup(
      createElement(NodeHead, {
        node: { node_id: "node1aaaaaaaaaaaaaaaa" },
        revision: revision({ body: `see ${REPO_PATH}\nand ${ABS_PATH}` }),
        loading: false,
        error: null,
      }),
    );
    expect(classesAround(html, REPO_PATH)).toContain(WRAP);
  });

  test("NodeHead: a text-format body (<pre>)", () => {
    const html = renderToStaticMarkup(
      createElement(NodeHead, {
        node: { node_id: "node1aaaaaaaaaaaaaaaa" },
        revision: revision({ body_format: "text", body: ABS_PATH }),
        loading: false,
        error: null,
      }),
    );
    expect(classesAround(html, ABS_PATH)).toContain(WRAP);
  });

  test("ContextPanel: an assembled-context item, and its header ids", () => {
    const item: ContextItem = {
      public_id: "m1",
      session_name: "session-01",
      peer_name: `peer-${"x".repeat(60)}`,
      role: "user",
      content: `ดูไฟล์นี้ก่อน: ${ABS_PATH}`,
      seq_in_session: "16",
      created_at: "2026-09-27T00:00:00.000000Z",
    };
    const html = renderToStaticMarkup(createElement(ContextItemRow, { item }));
    expect(classesAround(html, ABS_PATH.slice(0, 20))).toContain(WRAP);
    expect(classesAround(html, item.peer_name)).toContain(WRAP);
  });
});

describe("the same pattern elsewhere (nonblocking in wave 6)", () => {
  test("DialecticPanel: the chat answer", () => {
    const answer: ChatAnswer = { answer: `read ${ABS_PATH}`, coverage: "full", excluded: [], excluded_omitted: 0, items_used: [] };
    const html = renderToStaticMarkup(
      createElement(DialecticPanel, {
        onAsk: () => {},
        answer,
        asking: false,
        error: null,
        disabled: false,
        disabledReason: null,
      }),
    );
    expect(classesAround(html, ABS_PATH)).toContain(WRAP);
  });

  test("TracePanel: a hit excerpt", () => {
    const hit = {
      workspace_name: "default",
      trace_id: "t1",
      kind: "code",
      ref: "r",
      target: "{}",
      line_start: null,
      line_end: null,
      excerpt: `excerpt ${ABS_PATH}`,
      content_hash: null,
      captured_at: null,
      note: null,
      position: "0",
    } as TraceHitRow;
    const html = renderToStaticMarkup(
      createElement(TracePanel, {
        traceId: "t1",
        onTraceIdChange: () => {},
        onLookup: () => {},
        loading: false,
        trace: { id: "t1", status: "open" } as unknown as TraceRow,
        error: null,
        hits: [hit],
        hitsError: null,
        hasMoreHits: false,
        onLoadMoreHits: () => {},
      }),
    );
    expect(classesAround(html, ABS_PATH)).toContain(WRAP);
  });
});

const SRC = join(import.meta.dir, "..");
const FORM_CONTROL = new Set(["input", "select", "textarea", "option"]);
// `break-words` alone does not lower min-content (see the header), so it
// only counts beside `min-w-0`, which lets a flex/grid item shrink anyway.
const HAS_RULE = /(^|\s)(\[overflow-wrap:anywhere\]|break-all|truncate)(\s|$)/;
const hasRule = (cls: string) => HAS_RULE.test(cls) || (/(^|\s)break-words(\s|$)/.test(cls) && /(^|\s)min-w-0(\s|$)/.test(cls));

/** The className VALUE starting at `at` (just past `className=`): a quoted
 *  string, or a `{...}` expression -- template or conditional -- whose string
 *  literals are joined, so `cond ? "a font-mono" : "b"` is seen too. */
function classValue(text: string, at: number): string {
  if (text[at] === '"') return text.slice(at + 1, text.indexOf('"', at + 1));
  let depth = 0;
  let end = at;
  for (; end < text.length; end++) {
    if (text[end] === "{") depth++;
    if (text[end] === "}" && --depth === 0) break;
  }
  return [...text.slice(at, end).matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((s) => s[1] ?? s[2] ?? s[3]).join(" ");
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : [];
  });
}

/** `file:line <tag> classes` for every element that renders text verbatim
 *  (kept whitespace, monospace, `<pre>`, `<code>`) with no wrap rule. */
function unwrapped(): string[] {
  const out: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    // An element that carries a className always has whitespace after its
    // tag name, so a TS generic like `<string>` is never taken for the tag.
    const tags = [...text.matchAll(/<([a-z][a-z0-9]*)\s/g)];
    for (const m of text.matchAll(/className=(?=["{])/g)) {
      const cls = classValue(text, (m.index ?? 0) + m[0].length);
      const tag = tags.filter((t) => (t.index ?? 0) < (m.index ?? 0)).at(-1)?.[1] ?? "?";
      const verbatim = /(^|\s)(whitespace-pre[\w-]*|font-mono)(\s|$)/.test(cls) || tag === "pre" || tag === "code";
      if (verbatim && !FORM_CONTROL.has(tag) && !hasRule(cls)) {
        const line = text.slice(0, m.index).split("\n").length;
        out.push(`${relative(SRC, file)}:${line} <${tag}> ${cls}`);
      }
    }
    for (const m of text.matchAll(/<(pre|code)(>|\s)/g)) {
      const head = text.slice(m.index, text.indexOf(">", m.index));
      if (!/className=/.test(head)) out.push(`${relative(SRC, file)}:${text.slice(0, m.index).split("\n").length} <${m[1]}> (no className)`);
    }
  }
  return out;
}

describe("source guard: no verbatim-text element without a wrap rule", () => {
  test("every whitespace-pre*/font-mono className and every <pre>/<code> wraps or truncates", () => {
    expect(unwrapped()).toEqual([]);
  });
});
