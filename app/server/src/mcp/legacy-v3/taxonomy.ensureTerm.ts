import { CompatError } from "./compat-error";
import type { Kb } from "./createKb";
import { derivedId } from "./ids.derivedId";
import type { Row } from "./taxonomy.ensureReservedVocabularies";

const isEnvelope = (error: unknown): error is { code: string; toJSON(): unknown } =>
  typeof (error as { code?: unknown })?.code === "string" && typeof (error as { toJSON?: unknown })?.toJSON === "function";

/**
 * A4: a term by name inside one vocabulary, created on demand when missing
 * (v3 concepts were free tags) under an id derived from (bank, vocabulary,
 * name). A retired term cannot be newly assigned, so it is a refusal, not a
 * silent drop. A refused create -- a sealed vocabulary (R6) above all -- is a
 * `kernel_error` that NAMES the term (DESIGN.md:1089: never drop a concept
 * silently), with the v4 envelope carried unchanged.
 */
export async function ensureTerm(kb: Kb, bank: string, tool: string, vocabulary: Row, name: string): Promise<Row> {
  const lookup = () => kb("lookupTermByName", { vocabulary_id: vocabulary.id, name }) as Promise<Row | null>;
  const refuseRetired = (row: Row) => {
    if (row.is_active === false) {
      throw new CompatError(tool, "semantic_refusal", `${vocabulary.name} "${name}" is retired in this bank`,
        "a retired term stays in history but cannot be newly assigned");
    }
    return row;
  };
  const found = await lookup();
  if (found !== null) return refuseRetired(found);
  try {
    const created = (await kb("createTerm", {
      term_id: derivedId(bank, "term", vocabulary.name, name),
      vocabulary_id: vocabulary.id,
      name,
      description: null,
      parent_id: null,
    })) as { row: Row };
    return created.row;
  } catch (error) {
    if (isEnvelope(error) && error.code === "conflict") {
      const winner = await lookup();
      if (winner !== null) return refuseRetired(winner);
    }
    if (!isEnvelope(error)) throw error;
    throw new CompatError(tool, "kernel_error", `cannot create ${vocabulary.name} "${name}" in this bank (${error.code})`,
      `the ${vocabulary.name} vocabulary refused a new term; a sealed vocabulary only takes operator-created terms (R6)`,
      { v4Error: error.toJSON() });
  }
}
