import type { KernelHit } from "./search.retrieve";

/**
 * v3's OR over words (`search.keywordTerms.ts`), rebuilt from one v4 keyword
 * answer per word (R18 V5). An entry is a match when it holds any word.
 * Entries holding MORE of the words come first, then by the best place any
 * word's own answer gave them, then in the order first seen, so one word's
 * answer passes through in the kernel's own order. Only ORDER is consumed,
 * never a kernel score value (whose meaning is the kernel's to change).
 *
 * An entry is SHOWN (snippet, match) as the first query word it holds found
 * it, not the word where it ranked best: its place in another word's answer
 * moves whenever an unrelated entry is written (BM25 statistics, node-id
 * ties), and the same entry must not change its snippet for that.
 *
 * This merges keyword answers with keyword answers only; a semantic answer is
 * never merged into it (R7: never fused).
 */
export function mergeKeyword(answers: readonly { term: string; hits: readonly KernelHit[] }[]): (KernelHit & { matched_terms: string[] })[] {
  const byNode = new Map<string, { hit: KernelHit; terms: string[]; best: number; seen: number }>();
  let seen = 0;
  for (const { term, hits } of answers) {
    hits.forEach((hit, position) => {
      const entry = byNode.get(hit.node_id);
      if (entry === undefined) {
        byNode.set(hit.node_id, { hit, terms: [term], best: position, seen: seen++ });
        return;
      }
      entry.terms.push(term);
      entry.best = Math.min(entry.best, position);
    });
  }
  return [...byNode.values()]
    .sort((a, b) => b.terms.length - a.terms.length || a.best - b.best || a.seen - b.seen)
    .map((entry) => ({ ...entry.hit, matched_terms: entry.terms }));
}
