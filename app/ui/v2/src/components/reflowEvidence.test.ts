/** Failing-first RENDER guard (#33 AC2 round 6, verifier wave 7).
 *
 * Round 5's source guard keyed on the verbatim-text IDIOM (whitespace-pre*,
 * font-mono, <pre>, <code>), so a plain `<p className="text-muted">` or a
 * bare `<span>` holding user text passed it. The verifier measured two of
 * those live in Explore > Evidence, a tab round 5 never opened:
 *  - LifecyclePanel's supersede/retire `reason` (user text, capped only at
 *    4096 bytes): at 375px the `<p>` was client 314 / scroll 613 and the
 *    Evidence scroller 355 / 633;
 *  - SessionLinksPanel's `created_by_peer_name` span (up to 256 bytes) in a
 *    `flex items-center` row: row 314 / 588, scroller 355 / 609.
 * Its nonblocking list named the same shape in LifecycleActions', ErrorNote's
 * and SessionLinksPanel's error `<p>`s and ReplyComposer's "replying to".
 *
 * These tests key on the DATA, not on a class idiom: each fixture puts one
 * unbroken worst-case token in a server/user string field, renders the real
 * component, and asserts that the innermost element holding the token carries
 * `[overflow-wrap:anywhere]` (anywhere, not break-words: only anywhere lowers
 * the min-content width a flex/grid item or a centred column item sizes to).
 * `bun test src/components/reflowEvidence.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LifecycleEventRow, SessionLinkRow } from "../api/evidenceReview";
import type { MessageRow } from "../api/memory";
import { EmptyState } from "./EmptyState";
import { ErrorNote } from "./ErrorNote";
import { LifecycleActions } from "./LifecycleActions";
import { LifecyclePanel } from "./LifecyclePanel";
import { ReplyComposer } from "./ReplyComposer";
import { SessionLinksPanel } from "./SessionLinksPanel";

const URL_REASON =
  "superseded,see:https://github.com/Soul-Brews-Studio/arra-oracle-v4/blob/0ccda6a0ccda6a0ccda6a0ccda6a0ccda6a0ccda/app/server/src/knowledge/service.publishRevision.ts#L120";
const LONG_PEER = `peer${"x".repeat(80)}`;
const LONG_ERR = `refused_at_/content/link_snapshot_json/0/target/path/${"segment".repeat(20)}`;
const WRAP = "[overflow-wrap:anywhere]";

/** The class list of the innermost element whose text contains `needle`. */
function classesAround(html: string, needle: string): string[] {
  const at = html.indexOf(needle);
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<", at);
  return (html.slice(open, at).match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
}

function event(over: Partial<LifecycleEventRow>): LifecycleEventRow {
  return {
    id: "ev1",
    workspace_name: "default",
    old_id: "node1",
    old_revision_id: "rev1",
    old_title: "old",
    old_type: null,
    new_id: null,
    new_revision_id: null,
    new_title: null,
    reason: "r",
    peer_name: null,
    superseded_at: "2026-09-27T00:00:00.000000Z",
    operation_id: "op1",
    h_metadata: null,
    ...over,
  };
}

const lifecycle = (over: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(LifecyclePanel, {
      nodeId: "node1",
      recall: null,
      recallError: null,
      history: [],
      loading: false,
      error: null,
      ...over,
    }),
  );

const sessionLinks = (over: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(SessionLinksPanel, {
      sessionName: "session-01",
      direction: "from",
      onDirectionChange: () => {},
      rows: [],
      loading: false,
      error: null,
      hasMore: false,
      onLoadMore: () => {},
      ...over,
    }),
  );

describe("the verifier's two blocking sources wrap an unbroken token", () => {
  test("LifecyclePanel: a supersede reason holding a long URL, and its peer", () => {
    const html = lifecycle({ history: [event({ reason: URL_REASON, peer_name: LONG_PEER })] });
    expect(classesAround(html, URL_REASON)).toContain(WRAP);
  });

  test("SessionLinksPanel: an 84-char peer name in the attribution row", () => {
    const link: SessionLinkRow = {
      id: "l1",
      workspace_name: "default",
      from_session_name: "session-01",
      to_session_name: "session-03",
      relation: "related_to",
      evidence_ref: null,
      created_by_peer_name: LONG_PEER,
      created_at: "2026-09-27T00:00:00.000000Z",
    };
    const html = sessionLinks({ rows: [link] });
    expect(LONG_PEER.length).toBe(84);
    const own = classesAround(html, LONG_PEER);
    expect(own).toContain(WRAP);
    // The span is a flex item: min-w-0 lets it shrink below its token, and
    // flex-wrap drops created_at to the next line instead of off-screen.
    expect(own).toContain("min-w-0");
    const row = html.slice(html.lastIndexOf("<div", html.indexOf(LONG_PEER)));
    expect(row.match(/class="([^"]*)"/)?.[1].split(/\s+/)).toContain("flex-wrap");
  });
});

describe("the same shape the verifier listed as nonblocking", () => {
  test("LifecyclePanel: the history-read and recall errors", () => {
    expect(classesAround(lifecycle({ error: LONG_ERR }), LONG_ERR)).toContain(WRAP);
    expect(classesAround(lifecycle({ recallError: LONG_ERR }), LONG_ERR)).toContain(WRAP);
  });

  test("SessionLinksPanel: the read error and the empty-state session name", () => {
    expect(classesAround(sessionLinks({ error: LONG_ERR }), LONG_ERR)).toContain(WRAP);
    expect(classesAround(sessionLinks({ sessionName: LONG_PEER }), LONG_PEER)).toContain(WRAP);
  });

  test("EmptyState: title and detail (a centred column item sizes to min-content)", () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { title: LONG_PEER, detail: LONG_ERR }));
    expect(classesAround(html, LONG_PEER)).toContain(WRAP);
    expect(classesAround(html, LONG_ERR)).toContain(WRAP);
  });

  test("LifecycleActions: the write error", () => {
    const html = renderToStaticMarkup(
      createElement(LifecycleActions, {
        nodeId: "node1",
        expectedRevisionId: "rev1",
        busy: false,
        error: LONG_ERR,
        outcome: null,
        onRetire: () => {},
        onSupersede: () => {},
      }),
    );
    expect(classesAround(html, LONG_ERR)).toContain(WRAP);
  });

  test("ErrorNote: the message and the code", () => {
    const html = renderToStaticMarkup(createElement(ErrorNote, { error: { code: LONG_PEER, message: LONG_ERR } }));
    expect(classesAround(html, LONG_ERR)).toContain(WRAP);
    expect(classesAround(html, LONG_PEER)).toContain(WRAP);
  });

  test("ReplyComposer: 'replying to' a long peer name", () => {
    const replyingTo = { public_id: "m1", peer_name: LONG_PEER, content: "c" } as MessageRow;
    const html = renderToStaticMarkup(
      createElement(ReplyComposer, { replyingTo, peerName: "alice", onSend: () => {}, sending: false, onCancel: () => {} }),
    );
    expect(classesAround(html, LONG_PEER)).toContain(WRAP);
  });
});

describe("backstop: block text anywhere in the app breaks an overlong word", () => {
  // `overflow-wrap` is inherited, so one rule on <body> covers every block of
  // text a per-element class was missed on. `break-word`, not `anywhere`: it
  // only acts when a word would overflow its line, so it cannot change the
  // layout of anything that already fits (anywhere would lower every flex
  // item's min-content and could split short labels in a crowded row).
  test("index.css sets overflow-wrap: break-word on body", () => {
    const css = readFileSync(join(import.meta.dir, "..", "index.css"), "utf8");
    expect(css).toMatch(/body\s*\{[^}]*overflow-wrap:\s*break-word/);
  });
});
