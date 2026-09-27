import type { Kb } from "./createKb";
import { isEmbedderDown } from "./search.isEmbedderDown";
import { keywordTerms } from "./search.keywordTerms";
import { mergeKeyword } from "./search.mergeKeyword";

/** The kernel's own page cap (search-chunk-v1.md §13: `limit` 1..50): the most matches one v3 search can reach. */
export const SEARCH_WINDOW = 50;

/** One node hit as either #30 search returns it (keyword: `match`; semantic: `distance`). */
export type KernelHit = {
  node_id: string;
  revision_id: string;
  title: string;
  snippet: string;
  chunk_ids: string[];
  match?: string;
  distance?: number;
  matched_terms?: string[];
};

/** The kernel's own #30 coverage answer (search-chunk-v1.md §21): one bit, a
 *  closed reason and the bound itself -- never a count. Named locally rather
 *  than imported from `publication/*` (A1: the adapter owns no import there). */
type KernelCoverage = { coverage: "full" | "partial"; coverage_reason: "candidate_ceiling" | null; candidate_ceiling: number };

export type Retrieved = {
  hits: KernelHit[];
  /** Which retrieval answered: v3's `source` value. */
  source: "fts" | "vector";
  /** Keyword only: each term's own kernel answer mode (R14). */
  terms: { term: string; match: string; scan_reason: string | null }[] | null;
  dropped: string[];
  /** null when vectors were never consulted. */
  vectorAvailable: boolean | null;
  /** v3's single `metadata.warning` text, or null. */
  warning: string | null;
  /** True when v3's OWN 50-hit window may have cut matches off: `total` is
   *  then a lower bound. Independent of `coverage` below -- a kernel read can
   *  saturate its own candidate ceiling while this window stays wide open. */
  saturated: boolean;
  /** The kernel's own #30 coverage (search-chunk-v1.md §21), carried through
   *  rather than dropped: `"partial"` when ANY underlying candidate read (any
   *  term, for fts) reached `candidateCeiling`, so more matches may exist
   *  unread even when `hits.length` is far under `SEARCH_WINDOW`. */
  coverage: "full" | "partial";
  coverageReason: "candidate_ceiling" | null;
  candidateCeiling: number;
};

/**
 * Run ONE retrieval for a v3 recall tool (V3-PARITY.md §4.4; R7: keyword and
 * semantic are separate, never fused). Answers are current, recall-eligible
 * nodes only: the kernel decides that (R18 D3), not this adapter.
 *
 * - `fts`: one `searchKnowledgeKeyword` call per v3 word, merged as v3's OR.
 * - `vector`: one `searchKnowledgeSemantic` call over the whole query. When
 *   the query embedder does not answer (the kernel's `model_unavailable`, R21),
 *   it falls back to keyword and says so -- v3's own fallback to FTS
 *   (arra-oracle-v3 src/tools/search/handler.ts:75-88) -- rather than failing.
 *   No result is a warning, not an error: entries are embedded after they
 *   are saved (index first, embed later).
 */
export async function retrieve(kb: Kb, query: string, mode: "fts" | "vector"): Promise<Retrieved> {
  if (mode === "vector") {
    try {
      const answer = (await kb("searchKnowledgeSemantic", { query, limit: SEARCH_WINDOW })) as { hits: KernelHit[] } & KernelCoverage;
      return {
        hits: answer.hits,
        source: "vector",
        terms: null,
        dropped: [],
        vectorAvailable: true,
        warning: answer.hits.length > 0 ? null : "Vector search returned no results. Entries are embedded after they are saved, so recent ones may not be searchable by vector yet.",
        saturated: answer.hits.length >= SEARCH_WINDOW,
        coverage: answer.coverage,
        coverageReason: answer.coverage_reason,
        candidateCeiling: answer.candidate_ceiling,
      };
    } catch (error) {
      if (!isEmbedderDown(error)) throw error;
      const keyword = await retrieve(kb, query, "fts");
      return { ...keyword, vectorAvailable: false, warning: "Vector search unavailable: the query embedder did not answer. Using keyword search only." };
    }
  }
  const { terms, dropped } = keywordTerms(query);
  const answers: ({ term: string; match: string; scan_reason: string | null; hits: KernelHit[] } & KernelCoverage)[] = [];
  for (const term of terms) {
    const answer = (await kb("searchKnowledgeKeyword", { query: term, limit: SEARCH_WINDOW })) as { match: string; scan_reason: string | null; hits: KernelHit[] } & KernelCoverage;
    answers.push({ term, ...answer });
  }
  const merged = mergeKeyword(answers);
  // #30 coverage (search-chunk-v1.md §21): partial the moment ANY term's own
  // candidate read saturated, whatever the merged hit count ends up being --
  // this is the kernel's bound, not v3's 50-hit window (`saturated` below).
  const partial = answers.some((answer) => answer.coverage === "partial");
  return {
    hits: merged.slice(0, SEARCH_WINDOW),
    source: "fts",
    terms: answers.map(({ term, match, scan_reason }) => ({ term, match, scan_reason })),
    dropped,
    vectorAvailable: null,
    warning: null,
    saturated: merged.length > SEARCH_WINDOW || answers.some((answer) => answer.hits.length >= SEARCH_WINDOW),
    coverage: partial ? "partial" : "full",
    coverageReason: partial ? "candidate_ceiling" : null,
    candidateCeiling: answers[0]?.candidate_ceiling ?? 0,
  };
}
