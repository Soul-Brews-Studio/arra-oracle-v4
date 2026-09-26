import type { Kb } from "./createKb";
import { ensureReservedVocabularies, type Row } from "./taxonomy.ensureReservedVocabularies";
import { ensureTerm } from "./taxonomy.ensureTerm";
import { ensureVocabulary } from "./taxonomy.ensureVocabulary";

export type WantedTerms = {
  /** A5: `learning` stays `learning`; every other v3 type is `note` + `legacy_type`. */
  type: "learning" | "note" | "conclusion";
  horizon?: "short_term" | "long_term";
  concepts: readonly string[];
  legacyType?: string;
  project: string;
};

/**
 * The `term_snapshot_json` for one adapter publish (V3-PARITY.md §3 A4/A5):
 * resolve or create every vocabulary and term by name, then freeze them in
 * the revision-v1 snapshot shape. `label_snapshot` is always null for new
 * content (`service.validateTermReferences.ts`). The kernel still validates
 * every reference, cardinality and required vocabulary at publish time.
 */
export async function termSnapshot(kb: Kb, bank: string, tool: string, wanted: WantedTerms): Promise<string> {
  const reserved = await ensureReservedVocabularies(kb, bank);
  const picks: { vocabulary: Row; term: Row }[] = [];
  const pick = async (vocabulary: Row, name: string) => picks.push({ vocabulary, term: await ensureTerm(kb, bank, tool, vocabulary, name) });

  await pick(reserved.type, wanted.type);
  if (wanted.horizon !== undefined) await pick(reserved.memory_horizon, wanted.horizon);
  if (wanted.concepts.length > 0) {
    const concepts = await ensureVocabulary(kb, bank, "concepts");
    for (const name of wanted.concepts) await pick(concepts, name);
  }
  if (wanted.legacyType !== undefined) await pick(await ensureVocabulary(kb, bank, "legacy_type"), wanted.legacyType);
  await pick(await ensureVocabulary(kb, bank, "project"), wanted.project);

  return JSON.stringify(
    picks.map(({ vocabulary, term }, position) => ({
      term_id: term.id,
      vocabulary_id: vocabulary.id,
      vocabulary_name_snapshot: vocabulary.name,
      term_name_snapshot: term.name,
      label_snapshot: null,
      position: String(position),
    })),
  );
}
