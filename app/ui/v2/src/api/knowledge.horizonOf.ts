import { type TermSnapshot } from "./knowledge";

export function horizonOf(terms: TermSnapshot[]): string | null {
  return terms.find((t) => t.vocabulary_name_snapshot === "memory_horizon")?.term_name_snapshot ?? null;
}
