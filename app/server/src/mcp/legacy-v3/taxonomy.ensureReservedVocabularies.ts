import type { Kb } from "./createKb";
import { derivedId } from "./ids.derivedId";

export type Row = { id: string; name: string; is_active?: boolean } & Record<string, unknown>;

/** The seed manifest's literal term names (`seedReservedVocabularies` grammar). */
const TYPE_TERMS = ["note", "conclusion", "learning", "discussion", "correction"] as const;
const HORIZON_TERMS = ["short_term", "long_term"] as const;

/**
 * A4: find `type` and `memory_horizon` by NAME (K2), whoever created them and
 * under whatever ids. Only when one is missing is the idempotent reserved
 * seed called, reusing every id that already exists and deriving the rest,
 * so a replay (or a race with another adapter call) answers
 * `already_satisfied`. The seed's own rules (R6: a sealed vocabulary is never
 * extended by a caller) still decide; their refusal surfaces unchanged.
 */
export async function ensureReservedVocabularies(kb: Kb, bank: string): Promise<{ type: Row; memory_horizon: Row }> {
  const lookup = (name: string) => kb("lookupVocabularyByName", { name }) as Promise<Row | null>;
  let type = await lookup("type");
  let memoryHorizon = await lookup("memory_horizon");
  if (type !== null && memoryHorizon !== null) return { type, memory_horizon: memoryHorizon };

  const branch = async (existing: Row | null, vocabulary: string, names: readonly string[]) => {
    const terms: Record<string, string> = {};
    for (const name of names) {
      const found = existing === null ? null : ((await kb("lookupTermByName", { vocabulary_id: existing.id, name })) as Row | null);
      terms[name] = found?.id ?? derivedId(bank, "term", vocabulary, name);
    }
    return { vocabulary_id: existing?.id ?? derivedId(bank, "vocabulary", vocabulary), terms };
  };
  await kb("seedReservedVocabularies", {
    type: await branch(type, "type", TYPE_TERMS),
    memory_horizon: await branch(memoryHorizon, "memory_horizon", HORIZON_TERMS),
  });
  type = await lookup("type");
  memoryHorizon = await lookup("memory_horizon");
  if (type === null || memoryHorizon === null) throw new Error("reserved vocabularies missing after seed");
  return { type, memory_horizon: memoryHorizon };
}
