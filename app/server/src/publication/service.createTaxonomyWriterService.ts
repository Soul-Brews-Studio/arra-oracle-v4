import { createTaxonomyReadMethods } from "./service.createTaxonomyReadMethods";
import { createTerm } from "./service.createTerm";
import { createVocabulary } from "./service.createVocabulary";
import { renameTerm } from "./service.renameTerm";
import { reparentTerm } from "./service.reparentTerm";
import { retireTerm } from "./service.retireTerm";
import { seedReservedVocabularies } from "./service.seedReservedVocabularies";
import { type DatasetAdapter, type OwnerCore, type TaxonomyWriteOptions } from "./service.types";

export function createTaxonomyWriterService(
  writer: DatasetAdapter,
  core: OwnerCore,
  options: TaxonomyWriteOptions,
) {
  const reads = createTaxonomyReadMethods(writer);
  return {
    ...reads,

    createVocabulary: (requestBytes: Uint8Array) => createVocabulary(writer, core, options, requestBytes),
    createTerm: (requestBytes: Uint8Array) => createTerm(writer, core, options, requestBytes),
    renameTerm: (requestBytes: Uint8Array) => renameTerm(writer, core, options, requestBytes),
    retireTerm: (requestBytes: Uint8Array) => retireTerm(writer, core, options, requestBytes),
    reparentTerm: (requestBytes: Uint8Array) => reparentTerm(writer, core, options, requestBytes),
    seedReservedVocabularies: (requestBytes: Uint8Array) => seedReservedVocabularies(writer, core, options, requestBytes),
  };
}
