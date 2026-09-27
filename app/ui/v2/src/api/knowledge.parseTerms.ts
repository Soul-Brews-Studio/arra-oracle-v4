import { type RevisionRow, type TermSnapshot } from "./knowledge";

/** Terms are stored as JSON TEXT, so reading them back means parsing a column
 *  rather than walking an object. Returns [] on anything unexpected: a
 *  malformed snapshot should show as "no tags", never crash the panel. */
export function parseTerms(revision: RevisionRow | null): TermSnapshot[] {
  if (revision?.term_snapshot_json === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(revision.term_snapshot_json);
    return Array.isArray(parsed) ? (parsed as TermSnapshot[]) : [];
  } catch {
    return [];
  }
}
