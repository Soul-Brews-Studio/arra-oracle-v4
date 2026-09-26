import type { Kb } from "./createKb";

/**
 * A term's id by (vocabulary name, term name) -- K2's two by-name reads,
 * composed. `null` when EITHER the vocabulary or the term inside it was
 * never created: nothing in this bank could possibly carry that assignment,
 * so a caller filtering on it gets an honest empty result, never an error.
 */
export async function lookupTermIdByName(kb: Kb, vocabularyName: string, termName: string): Promise<string | null> {
  const vocabulary = (await kb("lookupVocabularyByName", { name: vocabularyName })) as { id: string } | null;
  if (vocabulary === null) return null;
  const term = (await kb("lookupTermByName", { vocabulary_id: vocabulary.id, name: termName })) as { id: string } | null;
  return term?.id ?? null;
}
