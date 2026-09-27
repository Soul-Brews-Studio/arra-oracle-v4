import { newPublicId } from "./memory";
import { type TaxonomyIds, TYPE_TERMS, HORIZON_TERMS, type TypeTerm, type HorizonTerm } from "./knowledge";

export function mintTaxonomyIds(): TaxonomyIds {
  return {
    type: {
      vocabulary_id: newPublicId(),
      terms: Object.fromEntries(TYPE_TERMS.map((t) => [t, newPublicId()])) as Record<TypeTerm, string>,
    },
    memory_horizon: {
      vocabulary_id: newPublicId(),
      terms: Object.fromEntries(HORIZON_TERMS.map((t) => [t, newPublicId()])) as Record<HorizonTerm, string>,
    },
  };
}
