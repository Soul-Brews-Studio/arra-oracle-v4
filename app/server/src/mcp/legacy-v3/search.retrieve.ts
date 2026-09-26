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
  /** True when the window may have cut matches off: `total` is then a lower bound. */
  saturated: boolean;
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
      const answer = (await kb("searchKnowledgeSemantic", { query, limit: SEARCH_WINDOW })) as { hits: KernelHit[] };
      return {
        hits: answer.hits,
        source: "vector",
        terms: null,
        dropped: [],
        vectorAvailable: true,
        warning: answer.hits.length > 0 ? null : "Vector search returned no results. Entries are embedded after they are saved, so recent ones may not be searchable by vector yet.",
        saturated: answer.hits.length >= SEARCH_WINDOW,
      };
    } catch (error) {
      if (!isEmbedderDown(error)) throw error;
      const keyword = await retrieve(kb, query, "fts");
      return { ...keyword, vectorAvailable: false, warning: "Vector search unavailable: the query embedder did not answer. Using keyword search only." };
    }
  }
  const { terms, dropped } = keywordTerms(query);
  const answers: { term: string; match: string; scan_reason: string | null; hits: KernelHit[] }[] = [];
  for (const term of terms) {
    const answer = (await kb("searchKnowledgeKeyword", { query: term, limit: SEARCH_WINDOW })) as { match: string; scan_reason: string | null; hits: KernelHit[] };
    answers.push({ term, ...answer });
  }
  const merged = mergeKeyword(answers);
  return {
    hits: merged.slice(0, SEARCH_WINDOW),
    source: "fts",
    terms: answers.map(({ term, match, scan_reason }) => ({ term, match, scan_reason })),
    dropped,
    vectorAvailable: null,
    warning: null,
    saturated: merged.length > SEARCH_WINDOW || answers.some((answer) => answer.hits.length >= SEARCH_WINDOW),
  };
}
