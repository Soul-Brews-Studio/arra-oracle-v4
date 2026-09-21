import { TaxonomyError, type TaxonomyErrorCode } from "./taxonomy-error";

export function failTaxonomy(code: TaxonomyErrorCode, path = ""): never {
  throw new TaxonomyError(code, path);
}
