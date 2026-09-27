import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { parseFilters, type CompatWarning } from "../search.parseFilters";
import { readCount } from "../search.readCount";
import { recall } from "../search.recall";
import { SEARCH_WINDOW } from "../search.retrieve";
import { v3Result } from "../search.v3Result";

const MODES = ["hybrid", "fts", "vector"] as const;
const COMPACT = ["compact-summary", "compact", "summary"];

/**
 * `oracle_search` (V3-PARITY.md §4.4; v3 src/tools/search/handler.ts:171-176,
 * shape test/fixtures/v3-compat-v1/shapes/oracle_search.json). 46% of real v3
 * calls. v3's arguments map onto the #30 knowledge searches, one retrieval
 * per call, never fused (R7):
 *  - `fts` -> keyword: v3's words, each a trigram substring search, so Thai
 *    is found inside words (R14);
 *  - `vector` -> semantic, falling back to keyword when the embedder is down;
 *  - `hybrid`, v3's default -> keyword, and `semantic_change` says fusion is
 *    not carried: v3's 50/50 fusion measured worse than either alone.
 * Superseded and retired entries are never recalled (D3); they stay readable
 * by id. Every deviation from v3's shape is named in `compat_warnings` (§2.5).
 */
export async function oracle_search(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const started = Date.now();
  const { tool } = context;
  const query = args.query;
  if (typeof query !== "string" || query.trim() === "") {
    throw new CompatError(tool, "unsupported_argument", "Query cannot be empty", "v3's own rule: a nonblank query", { path: "/query" });
  }
  const mode = args.mode ?? "hybrid";
  if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /mode: expected hybrid, fts or vector", "v3's mode enum", { path: "/mode" });
  }
  const filters = parseFilters(tool, args);
  const warnings: CompatWarning[] = [...filters.warnings];
  if (args.retrieval !== undefined && args.retrieval !== null && args.retrieval !== "full") {
    if (!COMPACT.includes(args.retrieval as string)) {
      throw new CompatError(tool, "unsupported_argument", "Invalid retrieval mode. Expected one of: full, compact-summary", "v3's retrieval enum", { path: "/retrieval" });
    }
    warnings.push({ code: "argument_ignored", field: "retrieval", detail: "compact-summary is not carried; content is the first 500 characters, as in full" });
  }
  const limit = readCount(tool, args, "limit", { fallback: 5, min: 1, max: SEARCH_WINDOW });
  const offset = readCount(tool, args, "offset", { fallback: 0, min: 0, max: SEARCH_WINDOW });
  if (limit.clamped) warnings.push({ code: "truncated", field: "limit", detail: `at most ${SEARCH_WINDOW} entries are reachable per query` });
  if (offset.value + limit.value > SEARCH_WINDOW) {
    warnings.push({ code: "truncated", field: "offset", detail: `v4 search reaches the first ${SEARCH_WINDOW} matches of a query; entries past that are not returned` });
  }
  if (mode === "hybrid") {
    warnings.push({ code: "semantic_change", field: "mode", detail: "hybrid fusion is not carried (keyword and semantic stay separate; fusing measured worse); answered by keyword search" });
  }

  const found = await recall(context.kb, { query, mode: mode === "vector" ? "vector" : "fts", type: filters.type, project: filters.project, want: offset.value + limit.value });
  const { retrieved } = found;
  if (mode === "vector" && retrieved.source === "fts") {
    warnings.push({ code: "semantic_change", field: "mode", detail: "the query embedder did not answer; answered by keyword search, as v3 fell back to FTS" });
  }
  if (retrieved.terms !== null && retrieved.terms.length > 1) {
    warnings.push({ code: "semantic_change", field: "query", detail: "v3 matched entries holding any word of the query (FTS5 OR); v4 searches each word as a substring and ranks entries holding more of the words first" });
  }
  if (retrieved.dropped.length > 0) {
    warnings.push({ code: "truncated", field: "query", detail: `words under 3 characters (in a query with longer ones) and words past the first 8 are not searched; ignored: ${retrieved.dropped.join(" ")}` });
  }
  const results = found.rows.slice(offset.value, offset.value + limit.value).map((row, i) => v3Result(row, offset.value + i, retrieved.source));
  if (results.length > 0) {
    warnings.push({ code: "field_unavailable", field: "source_file", detail: "v4 writes no file; the entry is a node in LanceDB (see id)" });
    warnings.push({ code: "semantic_change", field: "score", detail: "score is 1/(1+rank) in v4's order, not v3's fused relevance (metadata.score_kind)" });
  }
  if (retrieved.saturated) {
    warnings.push({ code: "partial", field: "metadata.total", detail: `v4 examines at most ${SEARCH_WINDOW} matches per query; total counts those` });
  }
  if (retrieved.coverage === "partial") {
    // #30 coverage (search-chunk-v1.md §21, amendment below): carried through
    // even when the 50-hit window above looks complete -- the kernel's own
    // candidate read can saturate with far fewer merged hits (R22 residual).
    warnings.push({
      code: "partial",
      field: "metadata.coverage",
      detail: `the kernel's own candidate read reached its bound (candidate_ceiling=${retrieved.candidateCeiling}, reason=${retrieved.coverageReason}); more matches may exist unread, even within this window`,
    });
  }

  const count = (source: string) => results.filter((result) => result.source === source).length;
  const keyword = retrieved.terms;
  return {
    results,
    total: results.length,
    query,
    metadata: {
      mode,
      mode_effective: retrieved.source,
      limit: limit.value,
      offset: offset.value,
      total: found.total,
      sources: { fts: count("fts"), vector: count("vector"), hybrid: 0 },
      searchTime: Date.now() - started,
      score_kind: "reciprocal_rank",
      ...(keyword === null
        ? {}
        : { match: keyword.every((term) => term.match === "ngram") ? "ngram" : "substring_scan", terms: keyword }),
      ...(mode === "vector" ? { vectorAvailable: retrieved.vectorAvailable === true } : {}),
      ...(retrieved.warning === null ? {} : { warning: retrieved.warning }),
    },
    compat_warnings: warnings,
  };
}
