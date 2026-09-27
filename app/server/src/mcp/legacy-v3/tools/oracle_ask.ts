import { extractiveAnswer } from "../ask.extractiveAnswer";
import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { parseFilters, type CompatWarning } from "../search.parseFilters";
import { recall } from "../search.recall";

/** v3 excerpt: whitespace collapsed, first 420 characters (synthesis.ts:168). */
const EXCERPT_CODE_POINTS = 420;

/** v3's question sanitizer (arra-oracle-v3 src/routes/ask/index.ts:37-39). */
const sanitize = (text: string) => text.replace(/<[^>]*>/g, "").replace(/[\x00-\x1f]/g, "").trim();

/** v3's source limit: 1..20, default 8, a fraction floored (index.ts:41-44). */
const limitOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(20, Math.floor(value))) : 8);

/**
 * `oracle_ask` (V3-PARITY.md §4.4; v3 src/tools/ask.ts, src/routes/ask/).
 *
 * `llm:false`: keyword recall over the question's words (the same path as
 * `oracle_search` fts, so superseded and retired entries never answer, D3),
 * then v3's extractive answer with citations. `llm:true`, v3's default, needs
 * a knowledge-grounded model method v4 does not have yet (K8
 * `answerFromKnowledge`, V3-PARITY.md §5; `answerChat` is session-grounded,
 * not knowledge-grounded). Until it exists the answer is extractive and a
 * `semantic_change` warning says `not_yet_available` -- v3's own fallback
 * when no model was configured (synthesis.ts:63-83). V9 replaces that branch.
 */
export async function oracle_ask(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const { tool } = context;
  const raw = args.question ?? args.q;
  const question = typeof raw === "string" ? sanitize(raw) : "";
  if (question === "") {
    throw new CompatError(tool, "unsupported_argument", "Invalid query: empty after sanitization", "v3's own rule: a nonblank question (or q)",
      { path: Object.hasOwn(args, "question") ? "/question" : "/q" });
  }
  const filters = parseFilters(tool, args);
  const limit = limitOf(args.limit);
  const found = await recall(context.kb, { query: question, mode: "fts", type: filters.type, project: filters.project, want: limit });

  const sources = found.rows.slice(0, limit).map(({ hit, facts }, i) => ({
    index: i + 1,
    id: hit.node_id,
    type: facts.v3Type,
    title: facts.title,
    sourceFile: null,
    score: 1 / (1 + i),
    confidence: null,
    excerpt: [...facts.body.replace(/\s+/g, " ").trim()].slice(0, EXCERPT_CODE_POINTS).join(""),
    stale: false,
  }));
  const synthesis = extractiveAnswer(sources);
  const byIndex = new Map(sources.map((source) => [source.index, source]));
  const citations = synthesis.citations.map((index) => {
    const { id, title, sourceFile, excerpt, score, confidence, stale } = byIndex.get(index)!;
    return { index, id, title, sourceFile, excerpt, score, confidence, stale };
  });

  const warnings: CompatWarning[] = [
    ...filters.warnings,
    { code: "semantic_change", field: "search", detail: "v3 ask ran hybrid search; v4 ask retrieves by keyword over the question's words (never fused), so search.vectorAvailable is null" },
  ];
  // v3: only `llm:false` asked for no model (index.ts:88); anything else asked for one.
  if (args.llm !== false) {
    warnings.push({ code: "semantic_change", field: "llm", detail: "not_yet_available: v4 has no knowledge-grounded model method yet (K8 answerFromKnowledge); answered extractively, as v3 did with no model configured" });
  }
  if (sources.length > 0) {
    warnings.push({ code: "field_unavailable", field: "sources[].sourceFile", detail: "v4 writes no file; the source is a node (see id)" });
    warnings.push({ code: "field_unavailable", field: "sources[].confidence", detail: "v4 has no confidence model; every source holds a word of the question" });
    warnings.push({ code: "semantic_change", field: "sources[].score", detail: "score is 1/(1+rank) in v4's order, not v3's fused relevance" });
  }
  if (found.retrieved.coverage === "partial") {
    // #30 coverage (search-chunk-v1.md §21): same signal oracle_search now
    // carries -- ask's keyword recall can saturate its candidate read with
    // far fewer sources than `limit`.
    warnings.push({
      code: "partial",
      field: "search.coverage",
      detail: `the kernel's own candidate read reached its bound (candidate_ceiling=${found.retrieved.candidateCeiling}, reason=${found.retrieved.coverageReason}); more matches may exist unread`,
    });
  }

  return {
    query: question,
    answer: synthesis.answer,
    citations,
    citationIndexes: synthesis.citations,
    warnings: synthesis.noEvidence ? ["no_evidence_found"] : [],
    noEvidence: synthesis.noEvidence,
    mode: "extractive",
    generatedAt: new Date().toISOString(),
    search: { total: found.total, limit, vectorAvailable: null, warning: found.retrieved.warning, mode_effective: found.retrieved.source },
    sources,
    compat_warnings: warnings,
  };
}
