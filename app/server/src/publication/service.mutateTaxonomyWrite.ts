import { asTaxonomyError } from "./service.asTaxonomyError";
import { type OwnerCore } from "./service.types";

export function mutateTaxonomyWrite<T>(core: OwnerCore, work: () => Promise<T>): Promise<T> {
return core.serial(work).catch(asTaxonomyError);
}
