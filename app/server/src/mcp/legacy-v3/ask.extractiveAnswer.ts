export type AskSource = { index: number; excerpt: string };

/** v3's answer text when no source supports one (arra-oracle-v3 src/routes/ask/synthesis.ts:73). */
const NO_EVIDENCE = "No evidence found in indexed oracle documents.";

/**
 * v3's extractive answer, ported as pure presentation (arra-oracle-v3
 * src/routes/ask/synthesis.ts:71-77, 112-115): the first three sources, each
 * as `[index] excerpt` on its own line, citing exactly those indexes. No
 * source is `noEvidence` with v3's fixed text and no citation. v3 also called
 * a set with every confidence under 0.12 no evidence; v4 has no confidence
 * model, and every v4 keyword source holds a query word, so an empty set is
 * the only no-evidence case here.
 */
export function extractiveAnswer(sources: readonly AskSource[]): { answer: string; citations: number[]; noEvidence: boolean } {
  if (sources.length === 0) return { answer: NO_EVIDENCE, citations: [], noEvidence: true };
  const cited = sources.slice(0, 3);
  return { answer: cited.map((source) => `[${source.index}] ${source.excerpt}`).join("\n"), citations: cited.map((source) => source.index), noEvidence: false };
}
