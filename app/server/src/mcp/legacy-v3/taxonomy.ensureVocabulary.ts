import type { Kb } from "./createKb";
import { derivedId } from "./ids.derivedId";
import type { Row } from "./taxonomy.ensureReservedVocabularies";

/**
 * A4 / D2: one of the adapter's own vocabularies (`concepts`, `legacy_type`,
 * `project`), found by name or created open, `cardinality:many`,
 * `required:false`, flat -- the R17 policy #34 uses for legacy tags. Its id is
 * derived from its name, so a replayed create is `already_satisfied`; a
 * `conflict` means another writer won the name, and the lookup finds theirs.
 */
export async function ensureVocabulary(kb: Kb, bank: string, name: string): Promise<Row> {
  const found = (await kb("lookupVocabularyByName", { name })) as Row | null;
  if (found !== null) return found;
  try {
    const created = (await kb("createVocabulary", {
      vocabulary_id: derivedId(bank, "vocabulary", name),
      name,
      label: name,
      description: null,
      kind: "tags",
      term_policy: "open",
      cardinality: "many",
      required: false,
      hierarchy: "flat",
    })) as { row: Row };
    return created.row;
  } catch (error) {
    if ((error as { code?: unknown }).code !== "conflict") throw error;
    const winner = (await kb("lookupVocabularyByName", { name })) as Row | null;
    if (winner === null) throw error;
    return winner;
  }
}
