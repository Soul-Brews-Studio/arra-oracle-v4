import { type TermSnapshot } from "./knowledge";

export function typeOf(terms: TermSnapshot[]): string | null {
  return terms.find((t) => t.vocabulary_name_snapshot === "type")?.term_name_snapshot ?? null;
}
