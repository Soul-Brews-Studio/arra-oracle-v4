import { SERVER_VERSION } from "../../protocol";
import type { V3ToolContext } from "../handlers";

type KnowledgeStats = {
  nodes_total: string;
  nodes_eligible: string | null;
  by_type: { term: string; count: string }[] | null;
  chunks: { embedding_profile: string; status: string; count: string }[] | null;
  vocabularies: string;
  terms: string;
  last_updated_at: string | null;
};

type ConceptsVocabulary = { id: string } | null;
type TermUsage = { rows: { term_id: string; name: string; count: string }[]; total_unique: string; coverage: "full" | "partial" };
type Warning = { code: string; field: string; detail: string };

/** Int64-decimal-text -> number: every count this tool prints is small
 *  enough to be a safe JS integer (`decimalOf`/K6/K7's own convention keeps
 *  the wire form a string so huge datasets never round; the v3 shape wants
 *  a plain number, and V3-PARITY.md §2.5 names exactly this conversion). */
function safeNumber(text: string): number {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * `oracle_stats` (V3-PARITY.md §4.3 "the other five" table row, §7 "V8";
 * v3 src/tools/stats.ts:75-95). Full (post-K7) shape: `total_documents`,
 * `by_type`, `fts_indexed` and `last_indexed` come from `knowledgeStats`
 * (K7); `unique_concepts` needs one more hop through the `concepts`
 * vocabulary (K6 `listTermUsage`), the same composition `oracle_concepts`
 * uses. `vector_status` is derived from the per-status chunk counts, never
 * a live LanceDB connection probe -- v4 IS the vector store, so there is no
 * separate service whose reachability could differ from this request's own.
 */
export async function oracle_stats(_args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const stats = (await context.kb("knowledgeStats", {})) as KnowledgeStats;
  const warnings: Warning[] = [];

  const by_type: Record<string, number> = {};
  if (stats.by_type === null) {
    warnings.push({ code: "partial", field: "by_type", detail: "more nodes than this build's bounded scan window; by_type is not exact" });
  } else {
    for (const row of stats.by_type) by_type[row.term] = safeNumber(row.count);
  }

  let fts_indexed = 0;
  let ready = 0;
  let pending = 0;
  let failed = 0;
  if (stats.chunks === null) {
    warnings.push({ code: "partial", field: "fts_indexed", detail: "more chunks than this build's bounded scan window; counts are not exact" });
  } else {
    for (const row of stats.chunks) {
      const count = safeNumber(row.count);
      fts_indexed += count;
      if (row.status === "ready") ready += count;
      else if (row.status === "pending") pending += count;
      else if (row.status === "failed") failed += count;
    }
  }
  const vector_status =
    stats.chunks === null ? "unknown" : fts_indexed === 0 ? "empty" : failed > 0 ? "degraded" : pending > 0 ? "pending" : "ready";
  const vector_reason =
    vector_status === "unknown"
      ? "chunk counts are not exact; see the fts_indexed warning"
      : vector_status === "pending"
        ? "some chunks are indexed but not yet embedded (the backfill worker fills them)"
        : vector_status === "degraded"
          ? "some chunks failed to embed"
          : undefined;

  let unique_concepts = 0;
  const conceptsVocabulary = (await context.kb("lookupVocabularyByName", { name: "concepts" })) as ConceptsVocabulary;
  if (conceptsVocabulary !== null) {
    const usage = (await context.kb("listTermUsage", {
      vocabulary_id: conceptsVocabulary.id,
      type_term: null,
      limit: 1,
    })) as TermUsage;
    unique_concepts = safeNumber(usage.total_unique);
    if (usage.coverage === "partial") {
      warnings.push({ code: "partial", field: "unique_concepts", detail: "more nodes than this build's bounded scan window; unique_concepts is not exact" });
    }
  }

  return {
    total_documents: safeNumber(stats.nodes_total),
    by_type,
    fts_indexed,
    unique_concepts,
    last_indexed: stats.last_updated_at,
    vector_status,
    ...(vector_reason === undefined ? {} : { vector_reason }),
    fts_status: fts_indexed > 0 ? "healthy" : "empty",
    version: SERVER_VERSION,
    ...(warnings.length > 0 ? { compat_warnings: warnings } : {}),
    v4: { nodes_eligible: stats.nodes_eligible, vocabularies: stats.vocabularies, terms: stats.terms },
  };
}
