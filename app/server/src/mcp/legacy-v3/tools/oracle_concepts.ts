import type { V3ToolContext } from "../handlers";

type ConceptsVocabulary = { id: string } | null;
type TermUsage = { rows: { term_id: string; name: string; count: string }[]; total_unique: string; coverage: "full" | "partial" };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function safeNumber(text: string): number {
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER;
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

/**
 * `oracle_concepts` (V3-PARITY.md §4.4 "the other five"; v3
 * src/tools/concepts.ts). Counted over the `concepts` vocabulary's
 * `node_revision_terms` rows for accepted heads (K6 `listTermUsage`), not
 * over a document-level JSON array as v3 counted it -- the number is the
 * same idea (how many current entries carry each tag), reached a different
 * way. A workspace with no `concepts` vocabulary yet (nothing has been
 * tagged) answers an exact empty list, not an error.
 *
 * `type` filters on v4's own reserved `type` vocabulary (`learning`, `note`,
 * `conclusion`, `discussion`, `correction`), not v3's `principle`/`pattern`/
 * `retro`/`learning`/`all` enum (R11: everything but `learning` maps to
 * `note`), so a v3 `type` value outside v4's set is a `semantic_change`
 * naming the difference, not a silent zero.
 */
export async function oracle_concepts(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const rawType = typeof args.type === "string" ? args.type : "all";
  const filterType = rawType === "" || rawType === "all" ? null : rawType;
  const limit = normalizeLimit(args.limit);

  const vocabulary = (await context.kb("lookupVocabularyByName", { name: "concepts" })) as ConceptsVocabulary;
  const warnings: { code: string; field: string; detail: string }[] = [];
  if (filterType !== null) {
    warnings.push({
      code: "semantic_change",
      field: "type",
      detail: "type filters on v4's own type vocabulary (learning, note, conclusion, discussion, correction), not v3's principle/pattern/retro",
    });
  }

  if (vocabulary === null) {
    return { concepts: [], total_unique: 0, filter_type: rawType, ...(warnings.length > 0 ? { compat_warnings: warnings } : {}) };
  }

  const usage = (await context.kb("listTermUsage", {
    vocabulary_id: vocabulary.id,
    type_term: filterType,
    limit,
  })) as TermUsage;

  if (usage.coverage === "partial") {
    warnings.push({ code: "partial", field: "concepts", detail: "more nodes than this build's bounded scan window; counts are not exact" });
  }

  return {
    concepts: usage.rows.map((row) => ({ name: row.name, count: safeNumber(row.count) })),
    total_unique: safeNumber(usage.total_unique),
    filter_type: rawType,
    ...(warnings.length > 0 ? { compat_warnings: warnings } : {}),
  };
}
