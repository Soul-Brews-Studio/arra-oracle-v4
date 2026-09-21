import { PublicationError } from "./errors";
import { type TaxonomyErrorCode, TaxonomyError } from "./taxonomy";

/**
 * Translate an owner-core failure into the taxonomy envelope.
 *
 * The shared core speaks one internal language (`PublicationError`) because it
 * is shared; each facade presents its own envelope. Every publication code has
 * a taxonomy counterpart, so this is total and never invents a classification
 * -- it carries code and path across unchanged. Anything that is NOT a
 * PublicationError is rethrown untouched, so governed `arra-error/v1`
 * diagnostics still pass through.
 */
export function asTaxonomyError(error: unknown): never {
  if (error instanceof PublicationError) {
    throw new TaxonomyError(error.code as TaxonomyErrorCode, error.path);
  }
  throw error;
}
