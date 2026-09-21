import type { TYPE_TERMS, HORIZON_TERMS } from "./taxonomy.constants";

/**
 * Shared by two or more functions: GetTermRequest by both parseGetTerm and
 * parseRetireTerm (via the RetireTermRequest alias); SeedRequest by
 * parseSeedRequest, seedVocabularyRows and seedTermRows.
 */
export type GetTermRequest = { workspace_name: string; term_id: string };

export type SeedRequest = {
  workspace_name: string;
  type: { vocabulary_id: string; terms: Record<(typeof TYPE_TERMS)[number], string> };
  memory_horizon: { vocabulary_id: string; terms: Record<(typeof HORIZON_TERMS)[number], string> };
};
