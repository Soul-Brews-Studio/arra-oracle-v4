/** Failing-first RENDER tests for #33 design revision 2 in the Knowledge node
 *  view: distinct author/observer/subject, provenance, missing summary and
 *  search freshness must be ON SCREEN for a lone head, not just computable.
 *
 * `renderToStaticMarkup` (already installed with react-dom, no DOM needed);
 * `createElement` keeps this a `.ts` file under tsconfig's test exclusion.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RevisionRow } from "../api/knowledge";
import { searchFreshnessView } from "../state/searchFreshnessView";
import { NodeHead } from "./NodeHead";
import { SearchFreshnessPanel } from "./SearchFreshnessPanel";

function revision(overrides: Partial<RevisionRow> = {}): RevisionRow {
  return {
    id: "rev1aaaaaaaaaaaaaaaaa", node_id: "node1aaaaaaaaaaaaaaaa", revision_no: "1", base_revision_id: null,
    operation_id: "op1aaaaaaaaaaaaaaaaaa", title: "หัวข้อ: a title", body: "BODY-FIRST-LINE and more",
    body_format: "text", fields: "{}", author_peer_name: "nat", observer_peer_name: "neo",
    subject_peer_name: "boy", session_name: "s1", is_active: true, valid_from: null, valid_to: null,
    change_reason: null, created_at: "2026-09-27T00:00:00.000Z", schema_version: "1",
    canonical_version: "arra-revision/v1", content_digest: "c".repeat(64), ...overrides,
  };
}

const head = (r: RevisionRow) =>
  renderToStaticMarkup(createElement(NodeHead, { node: { node_id: r.node_id }, revision: r, loading: false, error: null }));

/** The text of the element carrying `data-<attr>="<value>"`, tags stripped. */
function slot(html: string, attr: string, value: string): string | null {
  const m = html.match(new RegExp(`<([a-z]+)[^>]*data-${attr}="${value}"[^>]*>([\\s\\S]*?)</\\1>`));
  return m === null ? null : m[2]!.replace(/<[^>]+>/g, "");
}

describe("NodeHead: roles for a lone head", () => {
  test("author, observer and subject render as three labelled roles", () => {
    const html = head(revision());
    expect(slot(html, "role", "author")).toBe("nat");
    expect(slot(html, "role", "observer")).toBe("neo");
    expect(slot(html, "role", "subject")).toBe("boy");
    expect(html).not.toMatch(/>by</);
  });

  test("a missing observer is shown as missing", () => {
    const html = head(revision({ observer_peer_name: null }));
    expect(slot(html, "role", "observer")).toBe("no observer recorded");
    expect(slot(html, "role", "author")).toBe("nat");
  });
});

describe("NodeHead: provenance and the missing summary", () => {
  test("session, operation, base and full digest are on screen", () => {
    const html = head(revision());
    expect(slot(html, "prov", "session")).toBe("s1");
    expect(slot(html, "prov", "operation")).toBe("op1aaaaaaaaaaaaaaaaaa");
    expect(slot(html, "prov", "base")).toBe("none — first revision of this node");
    expect(slot(html, "prov", "digest")).toBe("c".repeat(64));
  });

  test("no summary is an explicit marker and holds none of the body", () => {
    const html = head(revision());
    const summary = slot(html, "prov", "summary");
    expect(summary).toBe("no summary");
    expect(summary).not.toContain("BODY-FIRST-LINE");
  });
});

describe("SearchFreshnessPanel: every state renders its own label", () => {
  const PROFILE = "minilm-l6-v2/384";
  const f = {
    content: { nodes: 1, revisions: 1 },
    text_index: { indexed_rows: null, unindexed_rows: null },
    vectors: { profile_id: PROFILE, pending: 1, ready: 0, failed: 0, last_attempt_at: null,
      model_digest: { pinned: null, last_measured: null } },
  };
  const c = (status: string) => ({ status, attempts: "0", error_code: status === "failed" ? "embedder_timeout" : null,
    embedding_profile: PROFILE, last_attempt_at: null });
  const render = (view: ReturnType<typeof searchFreshnessView>) =>
    renderToStaticMarkup(createElement(SearchFreshnessPanel, { view, onRecheck: () => {} }));
  const eligibility = { ok: true as const, body: { eligible: true, witness_event_id: "0", reasons: [] } };

  const cases: [string, ReturnType<typeof searchFreshnessView>][] = [
    ["unindexed", searchFreshnessView({ phase: "ok", freshness: f, chunks: [], eligibility })],
    ["pending", searchFreshnessView({ phase: "ok", freshness: f, chunks: [c("pending")], eligibility })],
    ["failed", searchFreshnessView({ phase: "ok", freshness: f, chunks: [c("failed")], eligibility })],
    ["indexed", searchFreshnessView({ phase: "ok", freshness: f, chunks: [c("ready")], eligibility })],
    ["unknown", searchFreshnessView({ phase: "error", stage: "freshness", message: "HTTP 503" })],
  ];
  for (const [state, view] of cases) {
    test(`${state}`, () => {
      const html = render(view);
      expect(html).toContain(`data-freshness-state="${state}"`);
      expect(slot(html, "freshness", "label")).toBe(view.label);
      if (state !== "unknown") expect(html).toContain(PROFILE);
    });
  }

  test("unknown never renders the word indexed as its state", () => {
    const html = render(cases[4]![1]);
    expect(slot(html, "freshness", "label")).toBe("unknown");
    expect(html).not.toContain('data-freshness-state="indexed"');
    expect(html).toContain("HTTP 503");
  });

  test("failed shows the stored error code", () => {
    expect(render(cases[2]![1])).toContain("embedder_timeout");
  });

  // Fix round (2026-09-27): findability is its own line, with its own state,
  // decided by recall eligibility -- never implied by the chunk label.
  test("a retired, fully indexed head renders an 'excluded' search line, not a findability claim", () => {
    const view = searchFreshnessView({
      phase: "ok",
      freshness: f,
      chunks: [c("ready")],
      eligibility: { ok: true, body: { eligible: false, witness_event_id: "1", reasons: ["retired"] } },
    });
    const html = render(view);
    expect(html).toContain('data-search-state="excluded"');
    expect(slot(html, "freshness", "search")).toContain("does not return this node");
    expect(html).not.toMatch(/can both|find this revision/);
  });

  test("an eligible indexed head renders a 'searchable' search line", () => {
    const html = render(cases[3]![1]);
    expect(html).toContain('data-search-state="searchable"');
    expect(slot(html, "freshness", "search")).toContain("keyword and semantic search can both return");
  });

  test("unknown freshness renders no search line", () => {
    expect(render(cases[4]![1])).not.toContain("data-search-state");
  });
});
