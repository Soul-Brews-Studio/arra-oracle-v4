import { asTaxonomyError } from "./service.asTaxonomyError";

export function readTaxonomy<T>(work: () => Promise<T>): Promise<T> {
return work().catch(asTaxonomyError);
}
