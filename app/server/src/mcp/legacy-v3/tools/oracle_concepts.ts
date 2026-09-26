import type { V3ToolContext } from "../handlers";
import { handoffWarning } from "../handoffWarning";
import { safeNumber } from "../safeNumber";
import { TYPE_TERMS } from "../taxonomy.ensureReservedVocabularies";

type ConceptsVocabulary = { id: string } | null;
type TermUsage = { rows: { term_id: string; name: string; count: string }[]; total_unique: string; coverage: "full" | "partial" };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const V4_TYPES: ReadonlySet<string> = new Set(TYPE_TERMS);

/** v3's own `normalizeLimit` (src/tools/concepts.ts), kept as-is: a missing,
 *  non-integer or non-positive limit (including `0`) is the default 50, and
 *  anything above 200 is 200. */
function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

/**
 * `oracle_concepts` (V3-PARITY.md §4.4 "the other five"; v3
 * src/tools/concepts.ts). K6 `listTermUsage` over the `concepts`
 * vocabulary: how many current heads carry each concept, counted from each
 * accepted head's own term snapshot (the same count v3 took per document,
 * reached a different way). A workspace with no `concepts` vocabulary yet
 * (nothing has been tagged) answers an exact empty list, not an error.
 *
 * `type` filters on v4's own reserved `type` vocabulary. v3's `learning` is
 * a v4 type too, so it passes through unchanged with no warning. v3's
 * `principle`/`pattern`/`retro` are NOT v4 types: the adapter stores them as
 * `note` plus a `legacy_type` term (A5), which this filter does not read, so
 * they match nothing and say so with `semantic_change` rather than a silent
 * zero.
 *
 * Every number here inherits K6's honesty: `coverage:"partial"` becomes a
 * `partial` warning, and a counted `handoff` concept (v3 never counted
 * handoffs) is named by `semantic_change`.
 */
export async function oracle_concepts(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const rawType = typeof args.type === "string" ? args.type : "all";
  const filterType = rawType === "" || rawType === "all" ? null : rawType;
  const limit = normalizeLimit(args.limit);

  const vocabulary = (await context.kb("lookupVocabularyByName", { name: "concepts" })) as ConceptsVocabulary;
  const warnings: { code: string; field: string; detail: string }[] = [];
  if (filterType !== null && !V4_TYPES.has(filterType)) {
    warnings.push({
      code: "semantic_change",
      field: "type",
      detail:
        "not a v4 type (learning, note, conclusion, discussion, correction); v3 principle/pattern/retro entries are stored as note plus a legacy_type term, which this filter does not read, so nothing matches",
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
  const handoff = handoffWarning(usage.rows, "concepts", "these counts");
  if (handoff !== null) warnings.push(handoff);

  return {
    concepts: usage.rows.map((row) => ({ name: row.name, count: safeNumber(row.count) })),
    total_unique: safeNumber(usage.total_unique),
    filter_type: rawType,
    ...(warnings.length > 0 ? { compat_warnings: warnings } : {}),
  };
}
