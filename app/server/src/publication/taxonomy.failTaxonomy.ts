import { TaxonomyError, type TaxonomyErrorCode } from "./taxonomy.TaxonomyError";

export function failTaxonomy(code: TaxonomyErrorCode, path = ""): never {
  throw new TaxonomyError(code, path);
}
