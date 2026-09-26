import { type EvidenceWriterBundle } from "../publication/service.types";
import { errorOutcome } from "./errorOutcome";
import { type Emit, type PlannedWorkspace, type WorkerControls } from "./plan.types";
import { requestBytes } from "./requestBytes";

/**
 * The taxonomy a migrated revision needs before it can be published, written
 * through the kernel's own taxonomy writers:
 *
 *   1. the reserved `type` / `memory_horizon` seed, with the plan's
 *      deterministic ids (publication requires exactly one `type` term);
 *   2. R11: when any legacy `type` was not a reserved term, one open
 *      `legacy_type` tag vocabulary -- R17 policy many / optional / flat --
 *      and one term per distinct original string.
 *
 * Taxonomy rows are stamped at the migration intake time: they are created BY
 * the migration and have no legacy time of their own.
 *
 * Returns `null` when the reserved seed was refused: no memory in the
 * workspace can be published. Otherwise returns the R11 tag names that are
 * NOT available (every tag when the vocabulary itself was refused), so the
 * caller rejects only the memories that carry one. One refused tag is its
 * memories' problem, never the whole workspace's.
 */
export async function seedWorkspaceTaxonomy(
  bundle: EvidenceWriterBundle,
  controls: WorkerControls,
  intakeMs: number,
  workspace: PlannedWorkspace,
  emit: Emit,
): Promise<Set<string> | null> {
  const ws = workspace.workspace_name;
  controls.now = intakeMs;
  const step = async (name: string, run: () => Promise<{ outcome: string }>) => {
    try {
      const result = await run();
      emit({ kind: "taxonomy", workspace: ws, step: name, outcome: result.outcome });
      return true;
    } catch (error) {
      emit({ kind: "taxonomy", workspace: ws, step: name, ...errorOutcome(error) });
      return false;
    }
  };

  const seeded = await step("seed_reserved", () =>
    bundle.taxonomy.seedReservedVocabularies(requestBytes({
      workspace_name: ws,
      type: workspace.seed.type,
      memory_horizon: workspace.seed.memory_horizon,
    })));
  if (!seeded) return null;

  const unavailable = new Set<string>();
  const vocabulary = workspace.legacy_type_vocabulary;
  if (vocabulary === null) return unavailable;
  const created = await step("legacy_type_vocabulary", () =>
    bundle.taxonomy.createVocabulary(requestBytes({
      workspace_name: ws,
      vocabulary_id: vocabulary.vocabulary_id,
      name: vocabulary.name,
      label: "Legacy type",
      description: "R11: original legacy memories.type strings that are not reserved type terms",
      kind: "tags",
      term_policy: "open",
      cardinality: "many",
      required: false,
      hierarchy: "flat",
    })));
  if (!created) return new Set(workspace.legacy_type_terms.map((term) => term.name));

  for (const term of workspace.legacy_type_terms) {
    const ok = await step(`legacy_type_term:${term.name}`, () =>
      bundle.taxonomy.createTerm(requestBytes({
        workspace_name: ws,
        term_id: term.term_id,
        vocabulary_id: vocabulary.vocabulary_id,
        name: term.name,
        description: null,
        parent_id: null,
      })));
    if (!ok) unavailable.add(term.name);
  }
  return unavailable;
}
