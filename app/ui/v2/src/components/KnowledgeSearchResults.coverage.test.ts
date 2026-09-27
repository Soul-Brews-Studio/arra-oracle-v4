/** Failing-first RENDER test (#30 coverage, `search-chunk-v1.md` section
 *  21). A search answer whose candidate read reached the server's bound says
 *  `coverage: "partial"`; the results panel must say so in words, for hits
 *  and for an empty answer, in both modes, and stay silent on "full".
 *  `bun test src/components/KnowledgeSearchResults.coverage.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgeSearchResults } from "./KnowledgeSearchResults";
import { applySearchOutcome, type SearchOutcome } from "../state/applySearchOutcome";
import { searchOutcomeView } from "../state/searchOutcomeView";

const NOTE = /results may be incomplete/i;
const keywordHit = { node_id: "n1", revision_id: "r1", title: "t", snippet: "s", chunk_ids: ["c1"], rank: 1, match: "ngram" as const };
const semanticHit = { node_id: "n2", revision_id: "r2", title: "t2", snippet: "s2", chunk_ids: ["c2"], distance: 0.5 };
const EMPTY: SearchOutcome = { mode: "keyword", errorCode: null, keywordHits: [], semanticHits: [], scanReason: null, embeddingProfile: null, coveragePartial: false };

/** The real path: one wire body -> `applySearchOutcome` -> `searchOutcomeView` -> render. */
function render(mode: "keyword" | "semantic", body: Record<string, unknown>) {
  const view = searchOutcomeView(applySearchOutcome(mode, { ok: true, status: 200, body } as never, EMPTY), mode);
  return renderToStaticMarkup(
    createElement(KnowledgeSearchResults, { query: "ลืม", mode, loading: false, ...view, onOpenNode: () => {} }),
  );
}
const signal = (coverage: "full" | "partial") => ({
  coverage,
  coverage_reason: coverage === "partial" ? "candidate_ceiling" : null,
  candidate_ceiling: 4096,
});

describe("KnowledgeSearchResults discloses a partial answer (#30 coverage)", () => {
  test("keyword hits with coverage partial show the note; full does not", () => {
    const partial = render("keyword", { match: "ngram", scan_reason: null, ...signal("partial"), hits: [keywordHit] });
    expect(partial).toMatch(NOTE);
    expect(partial).toContain("t</span>");
    expect(render("keyword", { match: "ngram", scan_reason: null, ...signal("full"), hits: [keywordHit] })).not.toMatch(NOTE);
  });

  test("an EMPTY partial answer is not a plain 'no results'", () => {
    const html = render("keyword", { match: "ngram", scan_reason: null, ...signal("partial"), hits: [] });
    expect(html).toMatch(NOTE);
    expect(html).toContain("No results for");
  });

  test("semantic answers carry it too", () => {
    const partial = render("semantic", { embedding_profile: "p", metric: "l2_squared", ...signal("partial"), hits: [semanticHit] });
    expect(partial).toMatch(NOTE);
    expect(render("semantic", { embedding_profile: "p", metric: "l2_squared", ...signal("full"), hits: [semanticHit] })).not.toMatch(NOTE);
  });

  test("an answer from before the field (no coverage) shows no note", () => {
    expect(render("keyword", { match: "ngram", scan_reason: null, hits: [keywordHit] })).not.toMatch(NOTE);
  });
});
