import { SERVER_VERSION } from "../../protocol";
import type { V3ToolContext } from "../handlers";
import { handoffWarning } from "../handoffWarning";
import { safeNumber } from "../safeNumber";

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

/**
 * `oracle_stats` (V3-PARITY.md §4.3 "the other five" table row, §7 "V8";
 * v3 src/tools/stats.ts:75-95). Full (post-K7) shape: `total_documents`,
 * `by_type`, `fts_indexed` and `last_indexed` come from `knowledgeStats`
 * (K7); `unique_concepts` needs one more hop through the `concepts`
 * vocabulary (K6 `listTermUsage`), the same composition `oracle_concepts`
 * uses. `vector_status` is derived from the per-status chunk counts, never
 * a live LanceDB connection probe -- v4 IS the vector store, so there is no
 * separate service whose reachability could differ from this request's own.
 *
 * Fix round (verifier finding 3): an unmeasured `knowledgeStats` field
 * (`null`, once a bounded scan is truncated) is passed through as `null`
 * here too, in every field it affects, each named in `compat_warnings` --
 * never a fabricated placeholder (an empty `{}`, a `0` count, or a guessed
 * `"empty"`/`"healthy"`) that a caller could mistake for a real, exact
 * answer. `by_type` and `last_updated_at` come from the SAME bounded node
 * scan inside `knowledgeStats`, so a null `by_type` always means
 * `last_updated_at` (`last_indexed` here) is unmeasured too, not
 * legitimately absent; both are warned together. `fts_indexed` and
 * `fts_status` come from the same bounded chunk scan and are nulled and
 * warned together the same way: a bank with thousands of unmeasured chunks
 * must never read back `fts_status:"empty"`.
 *
 * Second fix round: `unique_concepts` is K6's `total_unique`, now counted
 * from every accepted head's own term snapshot, so a head no writer
 * reconciled is no longer missing from it; a `coverage:"partial"` answer is
 * still named in `compat_warnings`. The K6 call asks for the full ranking
 * (200 rows, the kernel's cap, at no extra scan cost) rather than 1, so a
 * `handoff` concept is seen and named: v3 never counted handoffs, and
 * `oracle_handoff` nodes are in `total_documents`/`by_type.note` here.
 */
export async function oracle_stats(_args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const stats = (await context.kb("knowledgeStats", {})) as KnowledgeStats;
  const warnings: Warning[] = [];

  let by_type: Record<string, number> | null;
  if (stats.by_type === null) {
    by_type = null;
    warnings.push({ code: "partial", field: "by_type", detail: "more nodes than this build's bounded scan window; by_type is not exact" });
    warnings.push({ code: "partial", field: "last_indexed", detail: "the same bounded node scan that could not measure by_type also could not measure the newest updated_at" });
  } else {
    by_type = {};
    for (const row of stats.by_type) by_type[row.term] = safeNumber(row.count);
  }

  let fts_indexed: number | null;
  let fts_status: string | null;
  let ready = 0;
  let pending = 0;
  let failed = 0;
  if (stats.chunks === null) {
    fts_indexed = null;
    fts_status = null;
    warnings.push({ code: "partial", field: "fts_indexed", detail: "more chunks than this build's bounded scan window; counts are not exact" });
    warnings.push({ code: "partial", field: "fts_status", detail: "fts_indexed is not exact, so healthy/empty cannot be decided" });
  } else {
    let total = 0;
    for (const row of stats.chunks) {
      const count = safeNumber(row.count);
      total += count;
      if (row.status === "ready") ready += count;
      else if (row.status === "pending") pending += count;
      else if (row.status === "failed") failed += count;
    }
    fts_indexed = total;
    fts_status = total > 0 ? "healthy" : "empty";
  }
  // `ready + pending + failed`, never the (possibly null) `fts_indexed`
  // above: this branch only runs once `stats.chunks !== null`, and staying
  // off the nullable variable keeps that guaranteed by the type checker too.
  const vector_status =
    stats.chunks === null ? "unknown" : ready + pending + failed === 0 ? "empty" : failed > 0 ? "degraded" : pending > 0 ? "pending" : "ready";
  const vector_reason =
    vector_status === "unknown"
      ? "chunk counts are not exact; see the fts_indexed and fts_status warnings"
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
      limit: 200,
    })) as TermUsage;
    unique_concepts = safeNumber(usage.total_unique);
    if (usage.coverage === "partial") {
      warnings.push({ code: "partial", field: "unique_concepts", detail: "more nodes than this build's bounded scan window; unique_concepts is not exact" });
    }
    const handoff = handoffWarning(usage.rows, "total_documents", "total_documents and by_type.note");
    if (handoff !== null) warnings.push(handoff);
  }

  return {
    total_documents: safeNumber(stats.nodes_total),
    by_type,
    fts_indexed,
    unique_concepts,
    last_indexed: stats.last_updated_at,
    vector_status,
    ...(vector_reason === undefined ? {} : { vector_reason }),
    fts_status,
    version: SERVER_VERSION,
    ...(warnings.length > 0 ? { compat_warnings: warnings } : {}),
    v4: { nodes_eligible: stats.nodes_eligible, vocabularies: stats.vocabularies, terms: stats.terms },
  };
}
