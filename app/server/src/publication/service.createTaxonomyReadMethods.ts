import { getTerm } from "./service.getTerm";
import { getVocabulary } from "./service.getVocabulary";
import { type DatasetAdapter } from "./service.types";

export function createTaxonomyReadMethods(reader: DatasetAdapter) {
  return {
    getVocabulary: (requestBytes: Uint8Array) => getVocabulary(reader, requestBytes),
    getTerm: (requestBytes: Uint8Array) => getTerm(reader, requestBytes),
  };
}
