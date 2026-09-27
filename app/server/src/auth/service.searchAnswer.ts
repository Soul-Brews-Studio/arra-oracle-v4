import type { TextSearchResult } from "./service.types";

/**
 * The `GET /api/search` answer, built once for the response (`app.ts`) and
 * for its audit row (`service.ts`), so the row records what the caller got.
 * Text mode says how it matched (R14): "ngram", or "substring_scan" for a
 * query under 3 code points. Vector mode has no match mode to report. The
 * same shape MCP `recall` answers with.
 */
export function searchAnswer(mode: "text" | "vector", result: { match?: TextSearchResult["match"]; rows: unknown[] }) {
  return result.match === undefined
    ? { mode, count: result.rows.length, rows: result.rows }
    : { mode, match: result.match, count: result.rows.length, rows: result.rows };
}
