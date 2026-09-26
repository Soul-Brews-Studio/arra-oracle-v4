import { ContractError } from "../contracts/errors";
import { PublicationError } from "../publication/errors";
import { TaxonomyError } from "../publication/taxonomy.TaxonomyError";

/**
 * A governed refusal as a report line: `{code, path}` from any of the three
 * closed envelopes (`arra-error/v1`, publication, taxonomy). Anything else is
 * not a refusal but a fault, and is rethrown so the worker exits nonzero and
 * the orchestrator discards the candidate.
 */
export function errorOutcome(error: unknown): { outcome: "error"; code: string; path: string } {
  if (error instanceof ContractError || error instanceof PublicationError || error instanceof TaxonomyError) {
    return { outcome: "error", code: error.code, path: error.path };
  }
  throw error;
}
